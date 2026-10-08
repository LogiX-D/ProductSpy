import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  artifactRoot,
  artifactPath,
  copyPublic,
  digest,
  inventory,
  workspace,
  zipDirectory,
} from './packaging/files.mjs';
import { packageExtension } from './package-extension.mjs';
import { materializeModules } from './packaging/standalone.mjs';
import { writeThirdPartyNotices } from './packaging/notices.mjs';

const run = promisify(execFile);
const runtime = {
  version: '24.14.0',
  platform: 'win-x64',
  file: 'node-v24.14.0-win-x64.zip',
  sha256: '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66',
  source: 'https://nodejs.org/dist/v24.14.0/',
};
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Build the Windows x64 package on Windows x64 so native dependencies match');
const { version } = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
const name = `ProductSpy-${version}-windows-x64`;
const directory = artifactPath(name);
const archive = artifactPath(`${name}.zip`);
const cache = resolve(workspace, '.pack-cache');
const download = resolve(cache, runtime.file);
await mkdir(cache, { recursive: true });
await mkdir(artifactRoot, { recursive: true });
try {
  await access(download);
} catch {
  const response = await fetch(`${runtime.source}${runtime.file}`, {
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`Node runtime download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== runtime.sha256)
    throw new Error('Node runtime checksum does not match the pinned official release');
  await writeFile(`${download}.tmp`, bytes);
  await rename(`${download}.tmp`, download);
}
if ((await digest(download)) !== runtime.sha256)
  throw new Error('Cached Node archive checksum failed; remove the damaged cache and rebuild');
const expanded = resolve(cache, `node-${runtime.version}`);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
// Always expand the verified archive so a modified extracted cache cannot ship.
{
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${quote(download)} -DestinationPath ${quote(expanded)} -Force`,
    ],
    { windowsHide: true },
  );
}
const standalone = resolve(workspace, 'apps/web/.next/standalone');
await access(resolve(standalone, 'apps/web/server.js'));
// Refuse to replace an unrelated directory or a user's accidental data folder.
try {
  await access(directory);
  const marker = JSON.parse(await readFile(resolve(directory, 'bundle-manifest.json'), 'utf8'));
  if (marker.kind !== 'ProductSpy-portable')
    throw new Error('Output directory is not a ProductSpy build');
  await inventory(directory);
  await rm(directory, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(resolve(directory, 'runtime'), { recursive: true });
await copyPublic(standalone, resolve(directory, 'app'), ['node_modules']);
await materializeModules(
  resolve(standalone, 'apps/web/node_modules'),
  resolve(directory, 'app/apps/web/node_modules'),
  standalone,
);
await copyPublic(
  resolve(workspace, 'apps/web/.next/static'),
  resolve(directory, 'app/apps/web/.next/static'),
);
try {
  await access(resolve(workspace, 'apps/web/public'));
  await copyPublic(
    resolve(workspace, 'apps/web/public'),
    resolve(directory, 'app/apps/web/public'),
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await copyPublic(resolve(workspace, 'packaging/windows'), directory);
await copyPublic(resolve(workspace, 'apps/extension/dist'), resolve(directory, 'extension'));
for (const file of ['node.exe', 'LICENSE'])
  await cp(
    resolve(expanded, `node-v${runtime.version}-win-x64`, file),
    resolve(directory, 'runtime', file),
  );
await cp(resolve(workspace, 'PRIVACY.md'), resolve(directory, 'PRIVACY.md'));
const firstRun = (await readFile(resolve(workspace, 'docs/windows-guide.md'), 'utf8'))
  .replace('(../PRIVACY.md)', '(PRIVACY.md)')
  .replace(
    '(phase10-validation.md)',
    '(https://github.com/LogiX-D/ProductSpy/blob/main/docs/phase10-validation.md)',
  );
await writeFile(resolve(directory, 'FIRST-RUN.md'), firstRun);
await writeThirdPartyNotices(directory);
const files = await inventory(directory);
const metadata = {
  kind: 'ProductSpy-portable',
  version,
  architecture: 'windows-x64',
  runtime,
  files,
};
await writeFile(
  resolve(directory, 'bundle-manifest.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
await rm(archive, { force: true });
await zipDirectory(directory, archive, true);
const extension = await packageExtension();
const release = {
  version,
  portable: {
    file: `${name}.zip`,
    sha256: await digest(archive),
    bytes: (await readFile(archive)).length,
    files: files.length + 1,
  },
  extension: extension.result,
};
await writeFile(artifactPath('release-manifest.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(JSON.stringify(release, null, 2));
