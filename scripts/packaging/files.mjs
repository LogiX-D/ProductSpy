import { createHash } from 'node:crypto';
import { cp, lstat, readdir, readFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const workspace = resolve(import.meta.dirname, '../..');
export const artifactRoot = resolve(workspace, 'artifacts');
const privateName =
  /^(?:\.env(?:\..*)?|\.data|\.test-data|\.bridge-.*|products\.json|comparisons\.json|media-downloads\.json|analysis-usage\.json|settings\.json|ai-settings\.protected\.json|launcher-state\.json|stop-request\.json|logs|profile)$/i;

export function artifactPath(name) {
  const target = resolve(artifactRoot, name);
  if (target === artifactRoot || !target.startsWith(`${artifactRoot}${sep}`))
    throw new Error('Artifact target must remain inside the artifacts directory');
  return target;
}

export async function copyPublic(source, destination, excludedNames = []) {
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => !privateName.test(basename(path)) && !excludedNames.includes(basename(path)),
  });
}

export async function inventory(directory, prefix = '') {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const name = `${prefix}${entry.name}`;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Nonportable link in package: ${name}`);
    if (privateName.test(entry.name)) throw new Error(`Private file in package: ${name}`);
    if (info.isDirectory()) rows.push(...(await inventory(path, `${name}/`)));
    else {
      const bytes = await readFile(path);
      if (/\.(?:js|cjs|mjs|json|md|txt|ps1|cmd)$/i.test(name)) {
        const text = bytes.toString('utf8');
        if (
          /(?:sk-[a-zA-Z0-9]{24,}|gh[pousr]_[a-zA-Z0-9]{24,}|github_pat_[a-zA-Z0-9_]{40,})/.test(
            text,
          )
        )
          throw new Error(`Potential secret in package: ${name}`);
        const key = process.env.AI_API_KEY?.trim();
        if (key && key.length > 8 && text.includes(key))
          throw new Error(`Configured API Key leaked into package: ${name}`);
      }
      rows.push({
        path: name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export async function zipDirectory(source, destination, includeRoot = false) {
  if (process.platform !== 'win32') throw new Error('Windows packaging must run on Windows');
  artifactPath(relative(artifactRoot, destination));
  const quote = (text) => `'${text.replaceAll("'", "''")}'`;
  const directory = resolve(source);
  const sourcePrefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  const entryPrefix = includeRoot ? `${basename(directory)}/` : '';
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
        `$archive = [System.IO.Compression.ZipFile]::Open(${quote(destination)}, [System.IO.Compression.ZipArchiveMode]::Create)`,
        `try { foreach ($file in [System.IO.Directory]::EnumerateFiles(${quote(directory)}, '*', [System.IO.SearchOption]::AllDirectories)) { $entryName = ${quote(entryPrefix)} + $file.Substring(${sourcePrefix.length}).Replace('\\', '/'); [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null } } finally { $archive.Dispose() }`,
      ].join('; '),
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
  );
}

export async function digest(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
