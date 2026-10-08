import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  artifactRoot,
  artifactPath,
  copyPublic,
  digest,
  inventory,
  workspace,
  zipDirectory,
} from './packaging/files.mjs';
import { writeThirdPartyNotices } from './packaging/notices.mjs';

export async function packageExtension() {
  const source = resolve(workspace, 'apps/extension/dist');
  const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3)
    throw new Error('Expected a Manifest V3 production extension');
  const directory = artifactPath(`ProductSpy-${manifest.version}-extension`);
  try {
    await access(directory);
    const previous = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
    if (previous.name !== manifest.name)
      throw new Error('Extension staging directory is unrelated');
    await inventory(directory);
    await rm(directory, { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await copyPublic(source, directory);
  await writeThirdPartyNotices(directory);
  const files = await inventory(directory);
  if (
    !files.some(({ path }) => path === 'manifest.json') ||
    files.some(({ path }) => path.endsWith('.map'))
  )
    throw new Error('Extension must contain the root manifest and no development source maps');
  await mkdir(artifactRoot, { recursive: true });
  const output = artifactPath(`ProductSpy-${manifest.version}-extension.zip`);
  await rm(output, { force: true });
  await zipDirectory(directory, output);
  const result = {
    file: output.split(/[\\/]/).at(-1),
    version: manifest.version,
    sha256: await digest(output),
    files: files.length,
  };
  await writeFile(artifactPath('extension-manifest.json'), `${JSON.stringify(result, null, 2)}\n`);
  return { output, result };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  console.log(JSON.stringify((await packageExtension()).result, null, 2));
