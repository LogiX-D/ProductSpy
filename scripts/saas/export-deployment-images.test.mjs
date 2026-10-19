import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveName,
  createEncryption,
  configuration,
  createOutputDirectory,
  imageRecords,
  streamArchive,
  validateManifest,
} from './export-deployment-images.mjs';

import { decryptArchive } from './decrypt-deployment-images.mjs';

const recipient = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { format: 'pem', type: 'spki' },
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
});
const revision = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const sourceHead = 'c'.repeat(40);
const tags = ['productspy-web:ci', 'productspy-worker:ci'];
const env = {
  GITHUB_ACTIONS: 'true',
  RUNNER_OS: 'Linux',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_SHA: revision,
  GITHUB_RUN_ID: '1234',
  GITHUB_RUN_ATTEMPT: '1',
};
const event = {
  number: 1,
  pull_request: { head: { sha: sourceHead }, labels: [{ name: 'productspy-staging-package' }] },
};
const directories = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'productspy-export-test-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function inspections() {
  return tags.map((tag, index) => ({
    Id: `sha256:${String(index + 1).repeat(64)}`,
    RepoTags: [tag],
    Os: 'linux',
    Architecture: 'amd64',
    Size: 123456 + index,
    Config: {
      Labels: { 'org.opencontainers.image.revision': revision },
      Env: ['PRIVATE_VALUE=never-export-this'],
    },
    Mounts: [{ Source: '/private/test-data' }],
  }));
}
function producer(action) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => {
    child.stdout.destroy();
    child.emit('close', null);
    return true;
  });
  queueMicrotask(() => action(child));
  return child;
}

function metadata() {
  return {
    schemaVersion: 1,
    kind: 'ProductSpy-deployment-images',
    publication: 'encrypted-ci-artifact',
    createdAt: '2026-10-19T00:00:00.000Z',
    checkout: { sha: revision, tree },
    source: { headSha: sourceHead, pullRequest: 1 },
    github: { runId: '1234', runAttempt: '1' },
    platform: { os: 'linux', architecture: 'amd64' },
    images: imageRecords(inspections(), revision, tags),
  };
}
function encryption() {
  return createEncryption(recipient.publicKey, metadata());
}

describe('encrypted prebuilt image export boundaries (no Docker execution)', () => {
  it('requires GitHub Linux and an explicitly labeled PR, without changing push behavior', () => {
    expect(configuration(env, event, 'linux')).toMatchObject({
      revision,
      sourceHead,
      pullRequest: 1,
    });
    for (const changed of [
      { GITHUB_ACTIONS: 'false' },
      { RUNNER_OS: 'Windows' },
      { GITHUB_EVENT_NAME: 'push' },
      { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    ])
      expect(() => configuration({ ...env, ...changed }, event, 'linux')).toThrow();
    expect(() => configuration(env, event, 'win32')).toThrow();
    expect(() => configuration(env, { number: 1, pull_request: { labels: [] } }, 'linux')).toThrow(
      'PR label',
    );
    expect(() =>
      configuration(
        env,
        {
          ...event,
          pull_request: {
            ...event.pull_request,
            labels: [{ name: 'productspy-staging-package-extra' }],
          },
        },
        'linux',
      ),
    ).toThrow('PR label');
  });
  it('rejects missing revisions and run identity rather than exporting ambiguous builds', () => {
    for (const key of ['GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
      expect(() => configuration({ ...env, [key]: '' }, event, 'linux')).toThrow();
    expect(() =>
      configuration(env, { ...event, pull_request: { ...event.pull_request, head: {} } }, 'linux'),
    ).toThrow('head SHA');
    expect(() => configuration(env, { ...event, number: 0 }, 'linux')).toThrow('PR number');
  });
  it('refuses remote Docker overrides without exposing their values', () => {
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
      try {
        configuration({ ...env, [key]: 'private-value-never-echo' }, event, 'linux');
        throw new Error('Expected refusal');
      } catch (error) {
        expect(error.message).toContain(`configuration ${key} is forbidden`);
        expect(error.message).not.toContain('private-value-never-echo');
      }
    }
  });
  it('selects image identity metadata and excludes inspect environment and mounts', () => {
    const records = imageRecords(inspections(), revision, tags);
    expect(records.map((image) => image.tag)).toEqual([
      `productspy-web:${revision}`,
      `productspy-worker:${revision}`,
    ]);
    expect(JSON.stringify(records)).not.toContain('never-export-this');
    expect(JSON.stringify(records)).not.toContain('/private');
    expect(
      records.every((image) => image.revision === revision && image.architecture === 'amd64'),
    ).toBe(true);
  });
  it.each([
    [
      'wrong revision',
      (image) => {
        image.Config.Labels['org.opencontainers.image.revision'] = sourceHead;
      },
    ],
    [
      'wrong architecture',
      (image) => {
        image.Architecture = 'arm64';
      },
    ],
    [
      'wrong OS',
      (image) => {
        image.Os = 'windows';
      },
    ],
    [
      'invalid ID',
      (image) => {
        image.Id = 'not-an-image-id';
      },
    ],
    [
      'missing tag',
      (image) => {
        image.RepoTags = [];
      },
    ],
    [
      'invalid size',
      (image) => {
        image.Size = -1;
      },
    ],
  ])('rejects %s before starting an archive', (_name, change) => {
    const images = inspections();
    change(images[1]);
    expect(() => imageRecords(images, revision, tags)).toThrow();
  });
  it('refuses an existing output directory without altering its contents', async () => {
    const parent = await temporary();
    const name = `deployment-1234-1-${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}`;
    const directory = await createOutputDirectory(parent, name);
    await writeFile(join(directory, 'preserved'), 'original');
    await expect(createOutputDirectory(parent, name)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(directory, 'preserved'), 'utf8')).toBe('original');
    await expect(createOutputDirectory(parent, '../elsewhere')).rejects.toThrow('directory name');
  });
  it('refuses a symlink export parent', async () => {
    const root = await temporary();
    const target = await temporary();
    const link = join(root, 'linked-output');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      createOutputDirectory(link, 'deployment-1234-1-11111111-1111-1111-1111-111111111111'),
    ).rejects.toThrow('symlink');
  });
  it('streams authenticated encrypted gzip and waits for the producer to complete', async () => {
    const path = join(await temporary(), 'images.tar.gz');
    const payload = Buffer.from('synthetic Docker tar bytes for stream testing\n'.repeat(10000));
    const { cipher, encryption: envelope } = encryption();
    await streamArchive(
      path,
      () =>
        producer((child) => {
          child.stdout.end(payload);
          setTimeout(() => child.emit('close', 0), 5);
        }),
      cipher,
    );
    const ciphertext = await readFile(path);
    expect(ciphertext.includes(payload.subarray(0, 40))).toBe(false);
    const manifest = {
      ...metadata(),
      encryption: { ...envelope, authTag: cipher.getAuthTag().toString('base64') },
      archive: {
        file: archiveName,
        bytes: ciphertext.length,
        sha256: createHash('sha256').update(ciphertext).digest('hex'),
      },
    };
    const directory = await temporary();
    const identity = join(directory, 'synthetic-private.pem');
    const receipt = join(directory, 'manifest.json');
    const output = join(directory, 'decoded.tar.gz');
    await writeFile(identity, recipient.privateKey, { mode: 0o600 });
    await writeFile(receipt, JSON.stringify(manifest));
    await decryptArchive({ identity, archive: path, manifest: receipt, output });
    expect(gunzipSync(await readFile(output))).toEqual(payload);
    await expect(
      decryptArchive({ identity, archive: path, manifest: receipt, output }),
    ).rejects.toThrow('already exists');
    for (const kind of ['tag', 'source', 'ciphertext']) {
      const damaged = structuredClone(manifest);
      let bytes = Buffer.from(ciphertext);
      if (kind === 'tag') damaged.encryption.authTag = Buffer.alloc(16).toString('base64');
      if (kind === 'source') damaged.source.headSha = 'e'.repeat(40);
      if (kind === 'ciphertext') {
        bytes[0] ^= 1;
        damaged.archive.sha256 = createHash('sha256').update(bytes).digest('hex');
      }
      await writeFile(receipt, JSON.stringify(damaged));
      const input = join(directory, kind + '.enc');
      const failedOutput = join(directory, kind + '.gz');
      await writeFile(input, bytes);
      await expect(
        decryptArchive({ identity, archive: input, manifest: receipt, output: failedOutput }),
      ).rejects.toThrow();
      await expect(readFile(failedOutput)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it('removes a failed Docker archive even when stdout produced apparently valid bytes', async () => {
    const path = join(await temporary(), 'images.tar.gz');
    await expect(
      streamArchive(
        path,
        () =>
          producer((child) => {
            child.stdout.end('partial tar content');
            child.emit('close', 1);
          }),
        encryption().cipher,
      ),
    ).rejects.toThrow('incomplete archive removed');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('kills the producer and removes the archive after an input stream failure', async () => {
    const path = join(await temporary(), 'images.tar.gz');
    let child;
    await expect(
      streamArchive(
        path,
        () => {
          child = producer((running) => {
            running.stdout.write('some bytes');
            running.stdout.destroy(new Error('private-stream-error-never-echo'));
          });
          return child;
        },
        encryption().cipher,
      ),
    ).rejects.toThrow('incomplete archive removed');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never starts Docker or deletes an existing destination file', async () => {
    const path = join(await temporary(), 'images.tar.gz');
    await writeFile(path, 'preserve-this-file');
    const start = vi.fn();
    await expect(streamArchive(path, start, encryption().cipher)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(start).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe('preserve-this-file');
  });
  it('rejects stale images and mismatched checkout or archive receipts', () => {
    const images = imageRecords(inspections(), revision, tags);
    const archive = { file: archiveName, bytes: 42, sha256: 'd'.repeat(64) };
    const expected = { revision, tree, sourceHead, images, archive };
    const manifest = {
      schemaVersion: 1,
      kind: 'ProductSpy-deployment-images',
      encryption: { ...encryption().encryption, authTag: Buffer.alloc(16).toString('base64') },
      checkout: { sha: revision, tree },
      source: { headSha: sourceHead },
      images,
      archive,
    };
    expect(() => validateManifest(manifest, expected)).not.toThrow();
    for (const change of [
      (receipt) => {
        receipt.checkout.tree = sourceHead;
      },
      (receipt) => {
        receipt.source.headSha = revision;
      },
      (receipt) => {
        receipt.images[0].imageId = `sha256:${'e'.repeat(64)}`;
      },
      (receipt) => {
        receipt.images[1].revision = sourceHead;
      },
      (receipt) => {
        receipt.archive.bytes += 1;
      },
      (receipt) => {
        receipt.archive.sha256 = 'f'.repeat(64);
      },
      (receipt) => {
        receipt.archive.file = '../secret.env';
      },
    ]) {
      const changed = structuredClone(manifest);
      change(changed);
      expect(() => validateManifest(changed, expected)).toThrow();
    }
  });
});
