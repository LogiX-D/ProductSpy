import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const fromWeb = createRequire(resolve(workspace, 'apps/web/package.json'));
const JSZip = fromWeb('jszip');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const output = resolve(workspace, '.test-data/release-validation', stamp, 'zip-validation.json');
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  passed: false,
  checks: [],
  failures: [],
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function safeEntryName(name) {
  check(
    typeof name === 'string' && name.length > 0 && !/[\\\0:]/.test(name) && !name.startsWith('/'),
    `Unsafe ZIP path: ${JSON.stringify(name)}`,
  );
  const segments = name.replace(/\/$/, '').split('/');
  check(
    segments.every(
      (part) =>
        part &&
        part !== '.' &&
        part !== '..' &&
        !/[. ]$/.test(part) &&
        !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
    ),
    `Unsafe ZIP path: ${JSON.stringify(name)}`,
  );
}

// Inspect raw central-directory names before JSZip can sanitize traversal paths or merge duplicates.
function centralDirectory(bytes) {
  let end = -1;
  for (
    let position = bytes.length - 22;
    position >= Math.max(0, bytes.length - 65557);
    position--
  ) {
    if (
      bytes.readUInt32LE(position) === 0x06054b50 &&
      position + 22 + bytes.readUInt16LE(position + 20) === bytes.length
    ) {
      end = position;
      break;
    }
  }
  check(end !== -1, 'ZIP end-of-central-directory record is missing');
  check(
    bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0,
    'Split ZIP archives are not supported',
  );
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  check(
    count !== 0xffff && size !== 0xffffffff && cursor !== 0xffffffff,
    'ZIP64 archive requires a ZIP64-aware validator',
  );
  check(
    count === bytes.readUInt16LE(end + 8) && cursor + size === end,
    'ZIP central-directory bounds do not match',
  );
  const start = cursor;
  const names = new Set();
  const windowsNames = new Set();
  const entries = [];
  for (let index = 0; index < count; index++) {
    check(
      cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50,
      'Invalid ZIP central-directory record',
    );
    const flags = bytes.readUInt16LE(cursor + 8);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const length = 46 + nameLength + extraLength + commentLength;
    check(cursor + length <= end && !(flags & 1), 'Truncated or encrypted ZIP entry');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    safeEntryName(name);
    check(Buffer.from(name, 'utf8').equals(nameBytes), 'ZIP entry name is not valid UTF-8');
    const collisionName = name.replace(/\/$/, '').toLowerCase();
    check(!names.has(name) && !windowsNames.has(collisionName), `Duplicate ZIP path: ${name}`);
    names.add(name);
    windowsNames.add(collisionName);
    const local = bytes.readUInt32LE(cursor + 42);
    check(
      local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50,
      `Missing ZIP local header: ${name}`,
    );
    const localNameLength = bytes.readUInt16LE(local + 26);
    check(
      local + 30 + localNameLength <= start &&
        bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes),
      `ZIP local and central names disagree: ${name}`,
    );
    check(
      ((bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000) !== 0xa000,
      `Symbolic link in ZIP: ${name}`,
    );
    entries.push({ name, directory: name.endsWith('/'), bytes: bytes.readUInt32LE(cursor + 24) });
    cursor += length;
  }
  check(cursor === start + size, 'ZIP central-directory size does not match its entries');
  return entries;
}

const privateSegment =
  /^(?:\.env(?:\..*)?|\.data|\.test-data|\.git|\.pack-cache|\.workspace-restore|\.bridge-.*|products\.json|comparisons\.json|templates\.json|content-plans\.json|media-downloads\.json|analysis-usage\.json|settings\.json|ai-settings\.protected\.json|launcher-state\.json|stop-request\.json|pairing(?:-settings)?\.json|logs|profile)$/i;
const textFile =
  /(?:\.(?:js|cjs|mjs|json|map|html|css|svg|xml|ya?ml|md|txt|ps1|cmd|ini|conf|config)$|(?:^|\/)(?:LICENSE|NOTICE)(?:\.[^/]*)?$)/i;
const tokenPatterns = [
  ['OpenAI-style API token', /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{24,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['AWS access key ID', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Google API token', /\bAIza[0-9A-Za-z_-]{35}\b/],
  [
    'PEM private key',
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ],
];
const configuredKeys = [
  'AI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
]
  .map((name) => process.env[name]?.trim())
  .filter((value) => value && value.length > 8);

async function inspectArchive(kind, metadata, version) {
  check(
    metadata?.file ===
      `ProductSpy-${version}-${kind === 'portable' ? 'windows-x64' : 'extension'}.zip`,
    `${kind} archive name/version mismatch`,
  );
  const bytes = await readFile(resolve(workspace, 'artifacts', metadata.file));
  const hash = sha256(bytes);
  check(hash === metadata.sha256, `${kind} archive SHA256 does not match release-manifest.json`);
  if (metadata.bytes !== undefined)
    check(
      metadata.bytes === bytes.length,
      `${kind} archive byte count does not match release-manifest.json`,
    );
  const rawEntries = centralDirectory(bytes);
  const rawFiles = rawEntries.filter((entry) => !entry.directory);
  check(
    rawFiles.length === metadata.files,
    `${kind} file count does not match release-manifest.json`,
  );
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const loadedFiles = Object.values(zip.files).filter((entry) => !entry.dir);
  check(loadedFiles.length === rawFiles.length, `${kind} ZIP loader changed the file count`);
  const files = new Map();
  let scannedTextFiles = 0;
  for (const entry of rawEntries) {
    check(
      !entry.name.split('/').some((segment) => privateSegment.test(segment)),
      `${kind} contains a private file/directory: ${entry.name}`,
    );
    if (entry.directory) continue;
    const file = zip.file(entry.name);
    check(
      file && file.unsafeOriginalName === entry.name,
      `${kind} ZIP loader changed a raw entry name: ${entry.name}`,
    );
    const payload = await file.async('nodebuffer');
    check(
      payload.length === entry.bytes,
      `${kind} central-directory byte count mismatch: ${entry.name}`,
    );
    if (textFile.test(entry.name)) {
      scannedTextFiles++;
      const text = payload.toString('utf8');
      for (const [category, pattern] of tokenPatterns)
        check(!pattern.test(text), `${kind} suspected ${category} in ${entry.name}`);
      check(
        !configuredKeys.some((key) => text.includes(key)),
        `${kind} contains a configured API key in ${entry.name}`,
      );
    }
    files.set(entry.name, { path: entry.name, bytes: payload.length, sha256: sha256(payload) });
  }
  const result = {
    file: metadata.file,
    bytes: bytes.length,
    sha256: hash,
    entries: rawEntries.length,
    files: files.size,
    scannedTextFiles,
    crc32Verified: true,
    rawPathsVerified: true,
    privatePathsVerified: true,
    credentialPatternScanPassed: true,
    configuredApiKeysChecked: configuredKeys.length,
  };
  report[kind] = result;
  report.checks.push({
    name: `${kind}: archive hash, bytes, count, CRC32, raw paths, private paths and credential scan`,
    passed: true,
  });
  return { zip, files, result };
}

function validateExtensionManifest(manifest, version, label) {
  const sameSet = (actual, expected) =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().every((item, index) => item === [...expected].sort()[index]);
  check(
    manifest.manifest_version === 3 &&
      manifest.version === version &&
      manifest.name === 'ProductSpy',
    `${label}: MV3/name/version mismatch`,
  );
  check(
    sameSet(manifest.permissions, ['activeTab', 'scripting', 'storage']),
    `${label}: extension permissions changed`,
  );
  check(
    sameSet(manifest.host_permissions, ['http://localhost/*', 'http://127.0.0.1/*']),
    `${label}: extension host permissions changed`,
  );
  for (const field of [
    'optional_permissions',
    'optional_host_permissions',
    'content_scripts',
    'externally_connectable',
    'web_accessible_resources',
  ])
    check(manifest[field] === undefined, `${label}: unexpected capability ${field}`);
  check(
    manifest.background?.service_worker === 'background.js' &&
      manifest.background.type === 'module' &&
      manifest.action?.default_popup === 'popup.html',
    `${label}: extension entry points changed`,
  );
  check(
    manifest.content_security_policy?.extension_pages === "script-src 'self'; object-src 'self';",
    `${label}: extension CSP changed`,
  );
}

try {
  const project = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
  check(
    /^\d+\.\d+\.\d+$/.test(project.version),
    'Project release must have a valid numeric version',
  );
  const releaseBytes = await readFile(resolve(workspace, 'artifacts/release-manifest.json'));
  const release = JSON.parse(releaseBytes.toString('utf8'));
  check(release.version === project.version, 'Release manifest version does not match the project');
  report.version = release.version;
  report.releaseManifest = {
    path: 'artifacts/release-manifest.json',
    sha256: sha256(releaseBytes),
  };
  const extensionMetadata = JSON.parse(
    await readFile(resolve(workspace, 'artifacts/extension-manifest.json'), 'utf8'),
  );
  check(
    ['file', 'version', 'sha256', 'files'].every(
      (field) => extensionMetadata[field] === release.extension[field],
    ),
    'Extension and release manifests disagree',
  );

  const portable = await inspectArchive('portable', release.portable, release.version);
  const root = `ProductSpy-${release.version}-windows-x64/`;
  check(
    [...portable.files.keys()].every((name) => name.startsWith(root)),
    'Portable ZIP must have one expected top-level folder',
  );
  const bundlePath = `${root}bundle-manifest.json`;
  check(portable.files.has(bundlePath), 'Portable ZIP bundle-manifest.json is missing');
  const bundle = JSON.parse(await portable.zip.file(bundlePath).async('string'));
  check(
    bundle.kind === 'ProductSpy-portable' &&
      bundle.version === release.version &&
      bundle.architecture === 'windows-x64' &&
      Array.isArray(bundle.files),
    'Portable bundle manifest metadata is invalid',
  );
  const listed = new Set();
  for (const row of bundle.files) {
    safeEntryName(row.path);
    check(
      !listed.has(row.path) && row.path !== 'bundle-manifest.json' && !row.path.endsWith('/'),
      `Duplicate/invalid bundle manifest record: ${row.path}`,
    );
    listed.add(row.path);
    check(
      Number.isSafeInteger(row.bytes) && row.bytes >= 0 && /^[a-f0-9]{64}$/.test(row.sha256),
      `Invalid bundle checksum record: ${row.path}`,
    );
    const actual = portable.files.get(`${root}${row.path}`);
    check(
      actual && actual.bytes === row.bytes && actual.sha256 === row.sha256,
      `Portable bundle bytes/SHA256 mismatch: ${row.path}`,
    );
  }
  check(
    listed.size + 1 === portable.files.size,
    'Portable ZIP contains unlisted files or missing bundle records',
  );
  portable.result.bundleRecordsVerified = listed.size;
  report.checks.push({
    name: 'portable: every bundle record matches actual ZIP bytes/SHA256; no missing or unlisted files',
    passed: true,
    records: listed.size,
  });

  const extension = await inspectArchive('extension', release.extension, release.version);
  check(
    extension.files.has('manifest.json') &&
      extension.files.has('background.js') &&
      extension.files.has('popup.html'),
    'Extension ZIP root files are missing',
  );
  check(
    ![...extension.files.keys()].some((name) => /\.map$/i.test(name)),
    'Extension ZIP contains a source map',
  );
  const extensionManifest = JSON.parse(await extension.zip.file('manifest.json').async('string'));
  validateExtensionManifest(extensionManifest, release.version, 'extension ZIP');
  const portableExtensionPrefix = `${root}extension/`;
  const portableExtension = [...portable.files.values()].filter((row) =>
    row.path.startsWith(portableExtensionPrefix),
  );
  check(
    portableExtension.length > 0 && !portableExtension.some((row) => /\.map$/i.test(row.path)),
    'Portable extension is missing or contains source maps',
  );
  for (const row of portableExtension) {
    const name = row.path.slice(portableExtensionPrefix.length);
    const peer = extension.files.get(name);
    check(
      peer && peer.bytes === row.bytes && peer.sha256 === row.sha256,
      `Portable and standalone extension files disagree: ${name}`,
    );
  }
  const portableExtensionManifest = JSON.parse(
    await portable.zip.file(`${portableExtensionPrefix}manifest.json`).async('string'),
  );
  validateExtensionManifest(portableExtensionManifest, release.version, 'portable extension');
  extension.result.manifestVersion = extensionManifest.manifest_version;
  extension.result.permissions = extensionManifest.permissions;
  extension.result.hostPermissions = extensionManifest.host_permissions;
  extension.result.sourceMapsAbsent = true;
  portable.result.embeddedExtensionFilesVerified = portableExtension.length;
  report.checks.push({
    name: `extension: root MV3 ${release.version}, original permission/host allowlist, CSP, no source maps; embedded extension matches ZIP`,
    passed: true,
    embeddedFiles: portableExtension.length,
  });
  report.inventory = {
    portable: [...portable.files.values()],
    extension: [...extension.files.values()],
  };
  report.passed = true;
} catch (error) {
  report.failures.push(
    error instanceof Error ? error.message : 'Unknown release validation failure',
  );
  process.exitCode = 1;
}
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      passed: report.passed,
      report: output,
      portable: report.portable,
      extension: report.extension,
      failures: report.failures,
    },
    null,
    2,
  ),
);
