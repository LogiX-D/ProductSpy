import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateExtensionRelease } from '../packaging/release-version.mjs';

export const metadataName = 'productspy-build.json';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const privateSegment =
  /^(?:\.env(?:\..*)?|\.git|\.data|\.test-data|\.bridge-.*|profile|logs|products\.json|settings\.json|ai-settings\.protected\.json)$/i;
const serverSecrets = [
  'AI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'DATABASE_URL',
  'PRODUCTSPY_ARCHIVE_SECRET',
];
const patterns = [
  ['payment secret', /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]{16,}|\bwhsec_[A-Za-z0-9_]{16,}/],
  ['AI secret', /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{24,}/],
  ['GitHub secret', /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['database connection', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

export function assertPublicBytes(bytes, env = process.env) {
  for (const name of serverSecrets) {
    const value = env[name]?.trim();
    if (value && value.length >= 8 && bytes.includes(Buffer.from(value)))
      throw new Error(`Package rejected: configured server secret (${name}).`);
  }
  const text = bytes.toString('utf8');
  for (const [category, pattern] of patterns)
    if (pattern.test(text)) throw new Error(`Package rejected: ${category}.`);
}

export function packageTarget({ origin, mode = 'saas', environment }, allowTest = false) {
  assert(['saas', 'legacy'].includes(mode), 'Unknown extension deployment mode.');
  assert(
    (allowTest ? ['development', 'test', 'production'] : ['development', 'production']).includes(
      environment,
    ),
    'Explicit development or production extension environment required.',
  );
  assert(typeof origin === 'string' && origin, 'Explicit extension origin required.');
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Invalid extension origin.');
  }
  const hostname = url.hostname.replace(/\.$/, '');
  const loopback =
    ['localhost', '[::1]'].includes(hostname) ||
    /^127\./.test(hostname) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i.test(hostname);
  assert(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      !url.hostname.includes('*') &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)),
    'Extension origin must be exact HTTPS, or HTTP loopback for development.',
  );
  if (environment === 'production')
    assert(
      !loopback && url.protocol === 'https:',
      'Production requires a non-loopback HTTPS origin.',
    );
  if (!allowTest) assert.equal(mode, 'saas', 'SaaS preview packaging refuses legacy builds.');
  return { origin: url.origin, mode, environment };
}

export async function publicFiles(directory, env, skipMetadata = false) {
  assert(!(await lstat(directory)).isSymbolicLink(), 'Package source cannot be a symbolic link.');
  const rows = [];
  let total = 0;
  async function visit(root, prefix = '') {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      assert(
        !/[\\\0:]/.test(path) &&
          !path.split('/').some((s) => !s || s === '.' || s === '..' || /[. ]$/.test(s)),
        'Unsafe extension file path.',
      );
      assert(!privateSegment.test(entry.name), 'Package rejected: private file name.');
      const file = resolve(root, entry.name);
      const info = await lstat(file);
      assert(!info.isSymbolicLink(), 'Package rejected: symbolic link.');
      if (info.isDirectory()) await visit(file, `${path}/`);
      else {
        assert(
          info.isFile() && !path.endsWith('.map'),
          'Package rejected: unsupported file or source map.',
        );
        if (skipMetadata && path === metadataName) continue;
        const bytes = await readFile(file);
        total += bytes.length;
        assert(
          total <= 25 * 1024 * 1024 && rows.length < 1000,
          'Unexpected extension package size.',
        );
        if (env) assertPublicBytes(bytes, env);
        rows.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(directory);
  return rows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function writeExtensionBuildMetadata(directory, target, workspace) {
  const selected = packageTarget(target, true);
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  let revision = null,
    dirty = true;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    dirty = Boolean(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        cwd: workspace,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    /* Source archives can still produce explicitly marked development builds. */
  }
  const metadata = {
    schemaVersion: 1,
    kind: 'ProductSpy-extension-build',
    version: manifest.version_name ?? manifest.version,
    ...selected,
    source: { revision, dirty },
    files: await publicFiles(directory, undefined, true),
  };
  await writeFile(resolve(directory, metadataName), `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function validateCompiledExtension(directory, expected, version, env = process.env) {
  const target = packageTarget(expected);
  const metadataBytes = await readFile(resolve(directory, metadataName));
  assertPublicBytes(metadataBytes, env);
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  assert(
    metadata.schemaVersion === 1 && metadata.kind === 'ProductSpy-extension-build',
    'Missing extension build metadata contract.',
  );
  assert(
    metadata.origin === target.origin &&
      metadata.mode === target.mode &&
      metadata.environment === target.environment,
    'Compiled deployment metadata does not match the requested target.',
  );
  assert(metadata.version === version, 'Compiled extension application version differs.');
  assert(
    metadata.source && typeof metadata.source.dirty === 'boolean',
    'Missing source revision state.',
  );
  assert(
    metadata.source.revision === null || /^[a-f0-9]{40}$/.test(metadata.source.revision),
    'Invalid source revision.',
  );
  if (target.environment === 'production')
    assert(metadata.source.revision, 'Production preview requires a source commit.');
  const files = await publicFiles(directory, env, true);
  assert(
    JSON.stringify(files) === JSON.stringify(metadata.files),
    'Compiled file inventory or checksums changed after the build.',
  );
  assertPublicBytes(await readFile(resolve(directory, metadataName)), env);
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  const release = validateExtensionRelease(manifest, version);
  const allowedManifestFields = new Set([
    'manifest_version',
    'minimum_chrome_version',
    'name',
    'version',
    'version_name',
    'description',
    'icons',
    'permissions',
    'host_permissions',
    'action',
    'commands',
    'background',
    'content_security_policy',
  ]);
  assert(
    Object.keys(manifest).every((key) => allowedManifestFields.has(key)),
    'Unexpected SaaS extension manifest capability.',
  );
  assert(
    manifest.content_security_policy &&
      Object.keys(manifest.content_security_policy).length === 1 &&
      manifest.content_security_policy.extension_pages === "script-src 'self'; object-src 'self';",
    'Unexpected SaaS extension Content Security Policy.',
  );
  assert(
    Object.keys(manifest.background ?? {}).every((key) =>
      ['service_worker', 'type'].includes(key),
    ) &&
      Object.keys(manifest.action ?? {}).every((key) =>
        ['default_popup', 'default_title'].includes(key),
      ),
    'Unexpected SaaS extension entry point capability.',
  );
  for (const icon of Object.values(manifest.icons ?? {}))
    assert(
      typeof icon === 'string' && files.some((file) => file.path === icon),
      'Manifest icon must be a packaged file.',
    );
  assert(
    JSON.stringify(manifest.host_permissions) === JSON.stringify([`${target.origin}/*`]),
    'Manifest origin does not match the compiled target.',
  );
  assert(
    JSON.stringify([...(manifest.permissions ?? [])].sort()) ===
      JSON.stringify(['activeTab', 'alarms', 'scripting', 'storage'].sort()),
    'Unexpected SaaS extension permissions.',
  );
  assert(
    manifest.background?.service_worker === 'background.js' &&
      manifest.background.type === 'module' &&
      manifest.action?.default_popup === 'popup.html',
    'Unexpected extension entry points.',
  );
  for (const name of ['manifest.json', 'background.js', 'content.js', 'popup.html'])
    assert(
      files.some((f) => f.path === name),
      'Missing compiled extension entry point.',
    );
  return { metadata, manifest, release, files };
}
