import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  constants,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs, promisify } from 'node:util';
import {
  archiveName,
  decodeEnvelope,
  manifestAuthenticationData,
  recipientFingerprint,
  validateManifest,
} from './export-deployment-images.mjs';

const execute = promisify(execFile);

function inside(path, parent) {
  const fromParent = relative(parent, path);
  return (
    fromParent === '' ||
    (!isAbsolute(fromParent) && fromParent !== '..' && !fromParent.startsWith(`..${sep}`))
  );
}

async function privateIdentity(path) {
  assert(isAbsolute(path ?? ''), 'An explicit absolute private-key path is required with -i.');
  const actual = await realpath(path);
  const repository = await realpath(resolve(import.meta.dirname, '../..'));
  assert(
    !inside(actual, repository),
    'The decryption private key must remain outside the repository and its artifacts.',
  );
  const info = await lstat(actual);
  assert(info.isFile() && info.size > 0 && info.size <= 16_384, 'Private-key file invalid.');
  if (process.platform !== 'win32')
    assert((info.mode & 0o077) === 0, 'Private-key file requires owner-only permissions.');
  const pem = await readFile(actual);
  try {
    return createPrivateKey(pem);
  } finally {
    pem.fill(0);
  }
}

async function protectTemporaryDirectory(directory) {
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700);
    return;
  }
  // chmod does not establish NTFS privacy. Change only this newly owned temporary
  // directory, removing inherited entries and granting the current user's SID.
  const identity = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
    timeout: 10_000,
  });
  const sid = identity.stdout.match(/S-1-(?:[0-9]+-)+[0-9]+/)?.[0];
  assert(sid, 'Current Windows user SID unavailable.');
  await execute('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], {
    windowsHide: true,
    timeout: 10_000,
  });
}

async function ciphertextMetadata(path) {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    digest.update(chunk);
  }
  return { file: archiveName, bytes, sha256: digest.digest('hex') };
}

export async function decryptArchive({ identity, archive, manifest: manifestPath, output }) {
  assert(
    typeof archive === 'string' && typeof manifestPath === 'string' && typeof output === 'string',
    'Explicit archive, manifest and output paths required.',
  );
  const target = resolve(output);
  const parent = dirname(target);
  assert.equal(await realpath(parent), parent, 'Output parent must have a direct path.');
  try {
    await lstat(target);
    assert.fail('Output already exists; refusing to replace it.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert((await lstat(manifestPath)).size <= 1024 * 1024, 'Manifest is too large.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(
    [manifest.checkout?.sha, manifest.checkout?.tree, manifest.source?.headSha].every((value) =>
      /^[a-f0-9]{40}$/.test(value ?? ''),
    ),
    'Manifest source identity invalid.',
  );
  assert(
    manifest.publication === 'encrypted-ci-artifact' &&
      manifest.platform?.os === 'linux' &&
      manifest.platform?.architecture === 'amd64',
    'Unsupported deployment manifest.',
  );
  assert(
    Array.isArray(manifest.images) &&
      manifest.images.length === 2 &&
      manifest.images.every((image, index) => {
        const role = ['web', 'worker'][index];
        return (
          image.role === role &&
          image.tag === `productspy-${role}:${manifest.checkout.sha}` &&
          image.revision === manifest.checkout.sha &&
          /^sha256:[a-f0-9]{64}$/.test(image.imageId ?? '') &&
          image.os === 'linux' &&
          image.architecture === 'amd64'
        );
      }),
    'Manifest image identity invalid.',
  );
  const actual = await ciphertextMetadata(archive);
  validateManifest(manifest, {
    revision: manifest.checkout.sha,
    tree: manifest.checkout.tree,
    sourceHead: manifest.source.headSha,
    images: manifest.images,
    archive: actual,
  });
  const envelope = decodeEnvelope(manifest.encryption);
  const privateKey = await privateIdentity(identity);
  assert.equal(
    recipientFingerprint(createPublicKey(privateKey)),
    manifest.encryption.recipientFingerprintSha256,
    'Private key does not match the artifact recipient.',
  );
  const key = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    envelope.wrappedKey,
  );
  let decipher;
  try {
    assert(key.length === 32, 'Unwrapped AES key length invalid.');
    decipher = createDecipheriv('aes-256-gcm', key, envelope.iv, { authTagLength: 16 });
  } finally {
    key.fill(0);
  }
  decipher.setAAD(manifestAuthenticationData(manifest));
  decipher.setAuthTag(envelope.authTag);
  const temporary = await mkdtemp(join(parent, '.productspy-decrypt-'));
  try {
    await protectTemporaryDirectory(temporary);
    const partial = join(temporary, 'authenticated-archive.partial');
    const file = await open(partial, 'wx', 0o600);
    try {
      // GCM may emit plaintext before authentication completes. It stays inside
      // the private directory, is never sent to Docker, and is deleted on failure.
      await pipeline(createReadStream(archive), decipher, file.createWriteStream());
    } finally {
      await file.close();
    }
    // Hard-link publication is atomic and exclusive. Unlike rename(), it cannot
    // overwrite an existing target created while the authentication was running.
    await link(partial, target);
  } finally {
    assert(
      dirname(temporary) === parent && basename(temporary).startsWith('.productspy-decrypt-'),
      'Temporary cleanup path changed.',
    );
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    output: target,
    checkout: manifest.checkout.sha,
    recipientFingerprintSha256: manifest.encryption.recipientFingerprintSha256,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      identity: { type: 'string', short: 'i' },
      archive: { type: 'string', short: 'a' },
      manifest: { type: 'string', short: 'm' },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      'node scripts/saas/decrypt-deployment-images.mjs -i <absolute-private-key.pem> -a <images.tar.gz.enc> -m <deployment-manifest.json> -o <new-images.tar.gz>\nAuthenticates before publishing plaintext. Never uploads, runs Docker, overwrites files or reads a key from environment variables.',
    );
    return;
  }
  const result = await decryptArchive(values);
  console.log(JSON.stringify({ status: 'PASS', ...result }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  void main().catch(() => {
    // Never print PEM, unwrapped key, underlying crypto exceptions or environment.
    console.error('Image decryption failed; no unauthenticated archive was published.');
    process.exitCode = 1;
  });
