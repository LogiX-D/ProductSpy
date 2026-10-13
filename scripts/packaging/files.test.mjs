import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { artifactPath, artifactRoot, copyPublic, inventory, zipDirectory } from './files.mjs';

const run = promisify(execFile);

async function zipEntryNames(path) {
  const quotedPath = `'${path.replaceAll("'", "''")}'`;
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
        'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
        `$archive = [System.IO.Compression.ZipFile]::OpenRead(${quotedPath})`,
        'try { ConvertTo-Json -InputObject @($archive.Entries | ForEach-Object { $_.FullName }) -Compress } finally { $archive.Dispose() }',
      ].join('; '),
    ],
    { windowsHide: true },
  );
  return JSON.parse(stdout.trim());
}

async function fixture(run) {
  // Private fixture churn stays in isolated OS temp, outside watched source and
  // report directories. The actual ZIP still goes through artifactPath checks.
  const parent = resolve(tmpdir(), 'productspy-packaging-unit');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  if (!root.startsWith(`${parent}${sep}`)) throw new Error('Unsafe test cleanup');
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('distributable package boundaries', () => {
  it('rejects output traversal instead of touching unrelated folders', () => {
    expect(() => artifactPath('../apps/web')).toThrow();
    expect(() => artifactPath('.')).toThrow();
    expect(artifactPath('ProductSpy-test.zip')).toContain('artifacts');
  });

  it('excludes credentials and user data even if tracing included them', async () => {
    await fixture(async (root) => {
      const source = resolve(root, 'source');
      await mkdir(resolve(source, '.data'), { recursive: true });
      await mkdir(resolve(source, '.workspace-restore'), { recursive: true });
      await writeFile(resolve(source, 'server.js'), 'console.log("ready");');
      for (const file of [
        '.env.local',
        'products.json',
        'comparisons.json',
        'templates.json',
        'content-plans.json',
        'media-downloads.json',
        'analysis-usage.json',
        '.bridge-credentials.json',
        'settings.json',
      ])
        await writeFile(resolve(source, file), 'private');
      await writeFile(resolve(source, '.data/products.json'), 'private');
      await writeFile(
        resolve(source, '.workspace-restore/products.json.old'),
        'private staging snapshot',
      );
      const target = resolve(root, 'target');
      await copyPublic(source, target);
      expect((await inventory(target)).map((file) => file.path)).toEqual(['server.js']);
      expect(await readFile(resolve(target, 'server.js'), 'utf8')).toContain('ready');
    });
  });

  it('fails the package inspection when a key appears inside compiled code', async () => {
    await fixture(async (root) => {
      await writeFile(resolve(root, 'server.js'), `const key = "sk-${'x'.repeat(32)}";`);
      await expect(inventory(root)).rejects.toThrow('Potential secret');
    });
  });

  it.runIf(process.platform === 'win32')(
    'writes portable ZIP entries with extension root and optional Windows package root',
    async () => {
      await fixture(async (root) => {
        const name = 'ProductSpy-test-windows-x64';
        const source = resolve(root, name);
        await mkdir(resolve(source, '中文资料'), { recursive: true });
        await writeFile(resolve(source, 'manifest.json'), '{"manifest_version":3}');
        await writeFile(resolve(source, '中文资料/说明.txt'), '说明');
        await mkdir(artifactRoot, { recursive: true });
        const archive = artifactPath(`zip-entries-${basename(root)}.zip`);
        try {
          for (const includeRoot of [false, true]) {
            await zipDirectory(source, archive, includeRoot);
            const names = await zipEntryNames(archive);
            expect(names.every((entry) => !entry.includes('\\'))).toBe(true);
            const prefix = includeRoot ? `${name}/` : '';
            expect(names.sort()).toEqual([`${prefix}manifest.json`, `${prefix}中文资料/说明.txt`]);
            await rm(archive);
          }
        } finally {
          await rm(archive, { force: true });
        }
      });
    },
    20000,
  );
});
