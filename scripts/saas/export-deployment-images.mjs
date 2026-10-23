import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  constants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';

const execute = promisify(execFile);
const revisionLabel = 'org.opencontainers.image.revision';
const roles = ['web', 'worker'];
export const archiveName = 'productspy-images.tar.gz.enc';
const manifestName = 'deployment-manifest.json';
const isSha = (value) => /^[a-f0-9]{40}$/.test(value ?? '');
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function recipientFingerprint(publicKey) {
  assert(
    publicKey.asymmetricKeyType === 'rsa' && publicKey.asymmetricKeyDetails?.modulusLength === 4096,
    'RSA-4096 artifact recipient required.',
  );
  return hash(publicKey.export({ type: 'spki', format: 'der' }));
}

function base64(value, bytes) {
  assert(
    typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    'Encryption envelope encoding invalid.',
  );
  const decoded = Buffer.from(value, 'base64');
  assert(
    decoded.length === bytes && decoded.toString('base64') === value,
    'Encryption envelope length invalid.',
  );
  return decoded;
}

export function decodeEnvelope(envelope) {
  assert(
    envelope?.version === 1 &&
      envelope.algorithm === 'AES-256-GCM' &&
      envelope.keyWrapping === 'RSA-OAEP-SHA256',
    'Unsupported artifact encryption envelope.',
  );
  assert(
    /^[a-f0-9]{64}$/.test(envelope.recipientFingerprintSha256 ?? ''),
    'Recipient fingerprint invalid.',
  );
  return {
    iv: base64(envelope.iv, 12),
    authTag: base64(envelope.authTag, 16),
    wrappedKey: base64(envelope.wrappedKey, 512),
  };
}

export function manifestAuthenticationData(manifest) {
  const envelope = manifest.encryption;
  // The ciphertext checksum and authentication tag are deliberately excluded: both are
  // produced after streaming. Fixed source/image identity and envelope fields are bound.
  return Buffer.from(
    JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      kind: manifest.kind,
      publication: manifest.publication,
      createdAt: manifest.createdAt,
      checkout: manifest.checkout,
      source: manifest.source,
      github: manifest.github,
      platform: manifest.platform,
      images: manifest.images,
      encryption: {
        version: envelope.version,
        algorithm: envelope.algorithm,
        keyWrapping: envelope.keyWrapping,
        recipientFingerprintSha256: envelope.recipientFingerprintSha256,
        wrappedKey: envelope.wrappedKey,
        iv: envelope.iv,
      },
    }),
  );
}

export function createEncryption(publicPem, metadata) {
  const recipient = createPublicKey(publicPem);
  const fingerprint = recipientFingerprint(recipient);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  let cipher;
  let wrappedKey;
  try {
    wrappedKey = publicEncrypt(
      { key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      key,
    );
    cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  } finally {
    key.fill(0);
  }
  const encryption = {
    version: 1,
    algorithm: 'AES-256-GCM',
    keyWrapping: 'RSA-OAEP-SHA256',
    recipientFingerprintSha256: fingerprint,
    wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
  };
  cipher.setAAD(manifestAuthenticationData({ ...metadata, encryption }));
  return { cipher, encryption };
}

export function configuration(env, event, platform = process.platform) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Export runs only inside GitHub Actions.');
  assert(env.RUNNER_OS === 'Linux' && platform === 'linux', 'Export requires a Linux runner.');
  assert.equal(env.GITHUB_EVENT_NAME, 'pull_request', 'Export requires a pull_request event.');
  assert(
    event?.pull_request?.labels?.some((label) => label.name === 'productspy-staging-package'),
    'Export requires the productspy-staging-package PR label.',
  );
  assert(isSha(env.GITHUB_SHA), 'Current checkout SHA required.');
  assert(isSha(event.pull_request.head?.sha), 'Source PR head SHA required.');
  assert(Number.isSafeInteger(event.number) && event.number > 0, 'PR number required.');
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
    assert(/^[1-9][0-9]*$/.test(env[key] ?? ''), 'GitHub run identity required.');
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
    assert(!env[key], `Overridden Docker configuration ${key} is forbidden.`);
  return {
    revision: env.GITHUB_SHA,
    sourceHead: event.pull_request.head.sha,
    pullRequest: event.number,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}

export function imageRecords(inspections, revision, tags) {
  assert(Array.isArray(inspections) && inspections.length === 2, 'Both business images required.');
  return roles.map((role, index) => {
    const image = inspections[index];
    assert(image?.RepoTags?.includes(tags[index]), 'Expected local image tag missing.');
    assert(/^sha256:[a-f0-9]{64}$/.test(image.Id ?? ''), 'Docker image ID invalid.');
    assert(image.Os === 'linux' && image.Architecture === 'amd64', 'Linux amd64 images required.');
    assert(Number.isSafeInteger(image.Size) && image.Size > 0, 'Docker image size invalid.');
    assert(image.Config?.Labels?.[revisionLabel] === revision, 'Image checkout revision mismatch.');
    // Deliberately exclude Env, history, mounts and every unrelated inspect field.
    return {
      role,
      sourceTag: `productspy-${role}:ci`,
      tag: `productspy-${role}:${revision}`,
      imageId: image.Id,
      size: image.Size,
      os: image.Os,
      architecture: image.Architecture,
      revision: image.Config.Labels[revisionLabel],
    };
  });
}

export async function createOutputDirectory(parent, name) {
  assert(/^deployment-[0-9]+-[0-9]+-[a-f0-9-]{36}$/.test(name), 'Invalid export directory name.');
  await mkdir(parent, { recursive: true });
  assert(!(await lstat(parent)).isSymbolicLink(), 'Export parent must not be a symlink.');
  assert.equal(await realpath(parent), resolve(parent), 'Export parent must have a direct path.');
  const directory = resolve(parent, name);
  // No recursive flag: collisions, including symlinks, must fail without touching existing files.
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

export async function streamArchive(destination, startProducer, cipher) {
  assert(cipher, 'Artifact encryption cipher required.');
  // Open exclusively before starting Docker. On EEXIST, never remove the pre-existing file.
  const file = await open(destination, 'wx', 0o600);
  let producer;
  let transfer;
  let completion;
  try {
    producer = startProducer();
    completion = new Promise((accept, reject) => {
      producer.once('error', () => reject(new Error('Docker save could not start.')));
      producer.once('close', (code) =>
        code === 0 ? accept() : reject(new Error('Docker save did not complete successfully.')),
      );
    });
    transfer = pipeline(
      producer.stdout,
      createGzip({ level: 1 }),
      cipher,
      file.createWriteStream(),
    );
    await Promise.all([completion, transfer]);
  } catch {
    producer?.kill('SIGKILL');
    producer?.stdout?.destroy();
    await Promise.allSettled([completion, transfer]);
    await file.close();
    await rm(destination, { force: true });
    throw new Error('Image archive stream failed; incomplete archive removed.');
  }
  await file.close();
}

export function validateManifest(manifest, expected) {
  assert(
    manifest.schemaVersion === 1 && manifest.kind === 'ProductSpy-deployment-images',
    'Manifest type mismatch.',
  );
  assert(
    manifest.checkout?.sha === expected.revision && manifest.checkout?.tree === expected.tree,
    'Manifest checkout mismatch.',
  );
  assert(manifest.source?.headSha === expected.sourceHead, 'Manifest source head mismatch.');
  decodeEnvelope(manifest.encryption);
  assert(
    JSON.stringify(manifest.images) === JSON.stringify(expected.images),
    'Manifest image metadata changed during export.',
  );
  assert(
    manifest.archive?.file === archiveName &&
      manifest.archive?.bytes === expected.archive.bytes &&
      manifest.archive?.sha256 === expected.archive.sha256 &&
      Number.isSafeInteger(manifest.archive.bytes) &&
      manifest.archive.bytes > 0 &&
      /^[a-f0-9]{64}$/.test(manifest.archive.sha256),
    'Manifest archive mismatch.',
  );
}

async function command(executable, args) {
  try {
    return (
      await execute(executable, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error('Export command failed; raw logs and environment are suppressed.');
  }
}

const docker = (args) => command('docker', ['--context', 'default', ...args]);

async function archiveMetadata(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return { file: archiveName, bytes: (await stat(path)).size, sha256: digest.digest('hex') };
}

async function main() {
  assert(
    process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux',
    'Export runs only in Linux GitHub Actions.',
  );
  assert(
    isAbsolute(process.env.GITHUB_EVENT_PATH ?? '') && isAbsolute(process.env.GITHUB_OUTPUT ?? ''),
    'GitHub event and output files required.',
  );
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const config = configuration(process.env, event);
  const checkout = await command('git', ['rev-parse', 'HEAD']);
  const tree = await command('git', ['rev-parse', 'HEAD^{tree}']);
  assert(checkout === config.revision && isSha(tree), 'Actual Git checkout mismatch.');
  const sources = roles.map((role) => `productspy-${role}:ci`);
  const images = imageRecords(
    JSON.parse(await docker(['image', 'inspect', ...sources])),
    checkout,
    sources,
  );
  // Local immutable revision tags only; no registry login, push or new build is performed.
  for (const image of images) {
    const existing = await docker(['image', 'ls', '--quiet', '--filter', `reference=${image.tag}`]);
    assert(!existing, 'Export revision tag already exists; refusing to replace it.');
    await docker(['image', 'tag', image.imageId, image.tag]);
  }
  const name = `deployment-${config.runId}-${config.runAttempt}-${randomUUID()}`;
  const directory = await createOutputDirectory(resolve('artifacts/saas'), name);
  const partial = resolve(directory, `${archiveName}.partial`);
  const metadata = {
    schemaVersion: 1,
    kind: 'ProductSpy-deployment-images',
    publication: 'encrypted-ci-artifact',
    createdAt: new Date().toISOString(),
    checkout: { sha: checkout, tree },
    source: { headSha: config.sourceHead, pullRequest: config.pullRequest },
    github: { runId: config.runId, runAttempt: config.runAttempt },
    platform: { os: 'linux', architecture: 'amd64' },
    images,
  };
  const { cipher, encryption } = createEncryption(
    await readFile(resolve('.github/staging-artifact-recipient.pem'), 'utf8'),
    metadata,
  );
  await streamArchive(
    partial,
    () =>
      spawn(
        'docker',
        ['--context', 'default', 'image', 'save', ...images.map((image) => image.tag)],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 600_000,
          killSignal: 'SIGKILL',
        },
      ),
    cipher,
  );
  encryption.authTag = cipher.getAuthTag().toString('base64');
  const archive = await archiveMetadata(partial);
  const after = imageRecords(
    JSON.parse(await docker(['image', 'inspect', ...images.map((image) => image.tag)])),
    checkout,
    images.map((image) => image.tag),
  );
  const manifest = {
    ...metadata,
    encryption,
    archive,
  };
  validateManifest(manifest, { ...config, tree, images: after, archive });
  await rename(partial, resolve(directory, archiveName));
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(resolve(directory, manifestName), manifestBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(
    resolve(directory, 'SHA256SUMS'),
    `${archive.sha256}  ${archiveName}\n${hash(manifestBytes)}  ${manifestName}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `directory=${relative(process.cwd(), directory)}\nartifact-name=productspy-staging-${config.runId}-${config.runAttempt}-${checkout}\n`,
  );
  console.log(
    JSON.stringify({
      status: 'PASS',
      checkout,
      tree,
      archiveBytes: archive.bytes,
      directory: relative(process.cwd(), directory),
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  void main().catch(() => {
    // Do not emit inspect, event, environment, Docker stderr or exception objects.
    console.error('Deployment image export failed; no artifact has been published.');
    process.exitCode = 1;
  });
