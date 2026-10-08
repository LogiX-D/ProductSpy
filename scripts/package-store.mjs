import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { artifactPath, digest, inventory, zipDirectory, workspace } from './packaging/files.mjs';

const { version } = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
const directory = artifactPath('store');
const provenance = JSON.parse(await readFile(resolve(directory, 'asset-provenance.json'), 'utf8'));
if (!provenance.verified || provenance.fixture || provenance.version !== version)
  throw new Error('Capture the real running product before packaging store materials');
const fromWeb = createRequire(resolve(workspace, 'apps/web/package.json'));
const sharp = createRequire(fromWeb.resolve('next/package.json'))('sharp');
for (const screenshot of provenance.screenshots) {
  const path = resolve(directory, screenshot.file);
  if (!path.startsWith(`${directory}${sep}`)) throw new Error('Unsafe screenshot path');
  const size = await sharp(path).metadata();
  if (size.width !== 1280 || size.height !== 800 || (await digest(path)) !== screenshot.sha256)
    throw new Error('Screenshot dimensions or provenance checksum do not match');
}
const promo = await sharp(resolve(directory, 'promo-440x280.png')).metadata();
if (promo.width !== 440 || promo.height !== 280) throw new Error('Invalid promotional image');
await cp(resolve(workspace, 'docs/store'), resolve(directory, 'docs/store'), { recursive: true });
await cp(resolve(workspace, 'docs/windows-guide.md'), resolve(directory, 'docs/windows-guide.md'));
await cp(
  resolve(workspace, 'docs/phase10-validation.md'),
  resolve(directory, 'docs/phase10-validation.md'),
);
await cp(
  resolve(workspace, 'docs/phase10-results.json'),
  resolve(directory, 'docs/phase10-results.json'),
);
for (const file of ['chrome-web-store.md', 'phase9-validation.md'])
  await cp(resolve(workspace, 'docs', file), resolve(directory, 'docs', file));
await cp(resolve(workspace, 'PRIVACY.md'), resolve(directory, 'PRIVACY.md'));
await cp(
  resolve(workspace, 'artifacts/release-manifest.json'),
  resolve(directory, 'release-manifest.json'),
);
// Keep the directly readable first-run file as well as source-relative documentation.
const firstRun = (await readFile(resolve(workspace, 'docs/windows-guide.md'), 'utf8'))
  .replace('(../PRIVACY.md)', '(PRIVACY.md)')
  .replace('(phase10-validation.md)', '(docs/phase10-validation.md)');
await writeFile(resolve(directory, 'FIRST-RUN.md'), firstRun);
// Source-relative docs are the canonical copy; remove the old duplicate with broken links.
await rm(artifactPath('store/submission-text'), { recursive: true, force: true });
await rm(resolve(directory, 'asset-manifest.json'), { force: true });
await writeFile(
  resolve(directory, 'asset-manifest.json'),
  `${JSON.stringify(await inventory(directory), null, 2)}\n`,
);
const archive = artifactPath(`ProductSpy-${version}-store-materials.zip`);
await rm(archive, { force: true });
await zipDirectory(directory, archive);
console.log(
  JSON.stringify({ file: archive.split(/[\\/]/).at(-1), sha256: await digest(archive) }, null, 2),
);
