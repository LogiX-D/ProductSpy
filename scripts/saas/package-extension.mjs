import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { writeThirdPartyNotices } from '../packaging/notices.mjs';
import { workspace } from '../packaging/files.mjs';
import {
  packageTarget,
  publicFiles,
  sha256,
  validateCompiledExtension,
} from './package-extension-validation.mjs';

const fromWeb = createRequire(resolve(workspace, 'apps/web/package.json'));
const JSZip = fromWeb('jszip');

export async function verifySaasArchive(path, expectedFiles) {
  const zip = await JSZip.loadAsync(await readFile(path), {
    checkCRC32: true,
    createFolders: false,
  });
  const entries = Object.values(zip.files);
  assert(
    entries.length === expectedFiles.length && entries.every((entry) => !entry.dir),
    'ZIP inventory differs from the inspected package.',
  );
  for (const expected of expectedFiles) {
    const entry = zip.file(expected.path);
    assert(entry && entry.unsafeOriginalName === expected.path, 'ZIP root or entry path changed.');
    const bytes = await entry.async('nodebuffer');
    assert(
      bytes.length === expected.bytes && sha256(bytes) === expected.sha256,
      'ZIP payload checksum differs.',
    );
  }
  assert(
    zip.file('manifest.json') && zip.file('productspy-build.json'),
    'Extension ZIP must contain its manifest and build metadata at the root.',
  );
}

export async function packageSaasExtension({ environment, origin, source }, env = process.env) {
  const target = packageTarget({ environment, origin, mode: 'saas' });
  const project = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
  const root = resolve(workspace, 'artifacts');
  await mkdir(root, { recursive: true });
  assert(!(await lstat(root)).isSymbolicLink(), 'Artifacts directory cannot be a symbolic link.');
  const parent = resolve(root, 'saas');
  await mkdir(parent, { recursive: true });
  assert(
    !(await lstat(parent)).isSymbolicLink(),
    'SaaS artifacts directory cannot be a symbolic link.',
  );
  const run = resolve(parent, `extension-${environment}-${randomUUID()}`);
  assert(run.startsWith(`${parent}${sep}`), 'Unsafe SaaS preview output path.');
  await mkdir(run, { recursive: false, mode: 0o700 });
  const buildDirectory = source ? resolve(source) : resolve(run, 'build');
  if (!source) {
    // Programmatic Vite build uses an isolated output; existing dist and stable artifacts stay untouched.
    const { build } = await import('../../apps/extension/node_modules/vite/dist/node/index.js');
    const variables = {
      VITE_PRODUCTSPY_APP_URL: target.origin,
      VITE_PRODUCTSPY_MODE: target.mode,
      VITE_PRODUCTSPY_ENV: target.environment,
    };
    const before = Object.fromEntries(
      Object.keys(variables).map((name) => [name, process.env[name]]),
    );
    const priorDirectory = process.cwd();
    try {
      Object.assign(process.env, variables);
      process.chdir(resolve(workspace, 'apps/extension'));
      await build({
        root: process.cwd(),
        configFile: resolve(process.cwd(), 'vite.config.ts'),
        build: { outDir: buildDirectory, emptyOutDir: false },
      });
    } finally {
      process.chdir(priorDirectory);
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
  const checked = await validateCompiledExtension(buildDirectory, target, project.version, env);
  const directory = resolve(run, 'extension');
  await cp(buildDirectory, directory, { recursive: true, errorOnExist: true, force: false });
  await validateCompiledExtension(directory, target, project.version, env);
  await writeThirdPartyNotices(directory);
  const files = await publicFiles(directory, env);
  const zip = new JSZip();
  for (const file of files) {
    const bytes = await readFile(resolve(directory, file.path));
    assert(sha256(bytes) === file.sha256, 'Package changed while creating its ZIP.');
    zip.file(file.path, bytes, { createFolders: false });
  }
  const name = `ProductSpy-${project.version}-saas-${environment}-preview-extension.zip`;
  const archive = resolve(run, name);
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
  await verifySaasArchive(archive, files);
  const receipt = {
    schemaVersion: 1,
    kind: 'ProductSpy-saas-extension-preview',
    publication: 'not-published',
    scope:
      'Local preview package only; no deployed origin, store submission, cloud, TLS, AI or payment acceptance is implied.',
    version: project.version,
    ...target,
    source: checked.metadata.source,
    archive: { file: name, bytes: bytes.length, sha256: sha256(bytes) },
    files,
  };
  const receiptPath = resolve(run, 'package-receipt.json');
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { archive, receiptPath, receipt };
}

async function main() {
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      origin: { type: 'string' },
      source: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      'Local preview only: pnpm package:saas:extension --environment development|production --origin <exact-origin> [--source <compiled-directory>]\nWithout --source, builds an isolated MV3 package. Production requires SaaS metadata and a non-loopback HTTPS origin. No upload or publication occurs.',
    );
    return;
  }
  const result = await packageSaasExtension(values);
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        publication: 'not-published',
        archive: result.archive,
        receipt: result.receiptPath,
        environment: result.receipt.environment,
        origin: result.receipt.origin,
        sha256: result.receipt.archive.sha256,
        files: result.receipt.files.length,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  void main().catch((error) => {
    // Do not print exception objects, environment, source contents or configured secret values.
    const known =
      error instanceof assert.AssertionError || error.message?.startsWith('Package rejected:');
    console.error(
      known ? error.message.split('\n')[0] : 'SaaS extension preview packaging failed.',
    );
    process.exitCode = 1;
  });
