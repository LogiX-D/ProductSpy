import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { workspace } from './files.mjs';

const run = promisify(execFile);
const noticeName = /^(?:licen[cs]e|copying|notice)(?:[._-][a-z0-9._-]+)?$/i;
const markdownText = (value) =>
  String(value ?? '')
    .replace(/[|\r\n]/g, ' ')
    .trim();
const safeSegment = (value) =>
  String(value)
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '_');

async function assertContained(path, root) {
  const actual = await realpath(path);
  const base = await realpath(root);
  if (actual !== base && !actual.startsWith(`${base}${sep}`))
    throw new Error('Dependency notice source is outside the dependency directory');
  return actual;
}

async function noticeFiles(directory, recursive = false, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    const name = `${prefix}${entry.name}`;
    if (info.isDirectory() && recursive) files.push(...(await noticeFiles(path, true, `${name}/`)));
    else if (info.isFile() && noticeName.test(entry.name)) files.push({ path, name });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Copies only published license/notice texts, never package manifests or local paths. */
export async function writeNoticesFromInventory(
  target,
  licenseInventory,
  dependencyRoot = workspace,
) {
  const output = resolve(target);
  await mkdir(output, { recursive: true });
  const licenseDirectory = resolve(output, 'licenses');
  await mkdir(licenseDirectory, { recursive: true });
  await assertContained(licenseDirectory, output);
  const packages = [];
  const compiled = [];
  const seen = new Set();
  const originalRoots = new Map();

  async function copyNotice(source, destination, contents) {
    const path = resolve(licenseDirectory, destination);
    if (!path.startsWith(`${licenseDirectory}${sep}`))
      throw new Error('Dependency notice destination is outside the licenses directory');
    await mkdir(resolve(path, '..'), { recursive: true });
    await assertContained(resolve(path, '..'), licenseDirectory);
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Dependency notice is a link');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const bytes = contents ?? (await readFile(source));
    await writeFile(path, bytes);
    return {
      path: `licenses/${relative(licenseDirectory, path).split(sep).join('/')}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  for (const group of Object.values(licenseInventory)) {
    if (!Array.isArray(group)) throw new Error('Invalid pnpm license inventory');
    for (const record of group) {
      if (!Array.isArray(record.paths)) throw new Error('Missing pnpm dependency paths');
      for (const directory of record.paths) {
        const root = await assertContained(directory, dependencyRoot);
        const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
        if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string')
          throw new Error('Invalid dependency package metadata');
        const identity = `${metadata.name}@${metadata.version}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        originalRoots.set(identity, root);
        const license = typeof metadata.license === 'string' ? metadata.license : record.license;
        const slug = `${safeSegment(metadata.name)}-${safeSegment(metadata.version)}`;
        const files = [];
        for (const file of await noticeFiles(root))
          files.push(await copyNotice(file.path, `${slug}/${basename(file.name)}`));
        packages.push({ name: metadata.name, version: metadata.version, license, files });

        if (metadata.name === 'next') {
          const compiledRoot = resolve(root, 'dist/compiled');
          await assertContained(compiledRoot, root);
          for (const file of await noticeFiles(compiledRoot, true)) {
            const copied = await copyNotice(file.path, `${slug}/compiled/${file.name}`);
            compiled.push({
              source: `next ${metadata.version} / dist/compiled/${file.name}`,
              ...copied,
            });
          }
        }
      }
    }
  }

  // Some published tarballs retain their project's license declaration but omit its root text.
  // Preserve a verbatim README license section, or the installed upstream project's original text.
  for (const entry of packages.filter((item) => item.files.length === 0)) {
    const root = originalRoots.get(`${entry.name}@${entry.version}`);
    const slug = `${safeSegment(entry.name)}-${safeSegment(entry.version)}`;
    const readme = resolve(root, 'README.md');
    try {
      const contents = await readFile(readme, 'utf8');
      const section = contents.match(
        /^#{1,6}\s+Licen[cs]e\s*\r?\n[\s\S]*?(?=^#{1,6}\s|$(?![\s\S]))/im,
      )?.[0];
      if (section && /copyright/i.test(section) && /permission|redistribution/i.test(section)) {
        const copied = await copyNotice(readme, `${slug}/LICENSE-README.md`, Buffer.from(section));
        entry.files.push({ ...copied, source: 'Verbatim README.md license section' });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (entry.files.length > 0) continue;
    const family = entry.name.startsWith('@next/')
      ? 'next'
      : entry.name === 'client-only'
        ? 'react'
        : undefined;
    const upstream = packages.find(
      (item) =>
        item.name === family &&
        item.license === entry.license &&
        (family !== 'next' || item.version === entry.version),
    );
    if (!upstream) continue;
    const upstreamRoot = originalRoots.get(`${upstream.name}@${upstream.version}`);
    const licenseFile = (await noticeFiles(upstreamRoot)).find((file) =>
      /^licen[cs]e/i.test(file.name),
    );
    if (!licenseFile) continue;
    const copied = await copyNotice(licenseFile.path, `${slug}/UPSTREAM-LICENSE.md`);
    entry.files.push({
      ...copied,
      source: `Original ${upstream.name}@${upstream.version} project ${licenseFile.name}; this package declares the same project license but ships no separate text`,
    });
  }

  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const missingLicenseTexts = packages
    .filter((entry) => entry.files.length === 0)
    .map((entry) => `${entry.name}@${entry.version}`);
  const lines = [
    '# Third-party notices',
    '',
    'ProductSpy includes open-source dependencies. Their original license, copyright and notice texts are preserved in the adjacent `licenses/` directory. The table is generated from the installed production dependency inventory; it may include build-time transitive dependencies in addition to distributed runtime code.',
    '',
    'The Windows portable distribution also includes the original Node.js license at `runtime/LICENSE`. JSZip is used under its MIT license option.',
    '',
    '| Package | Version | Declared license | Original text |',
    '| --- | --- | --- | --- |',
    ...packages.map(
      (entry) =>
        `| ${markdownText(entry.name)} | ${markdownText(entry.version)} | ${markdownText(entry.license || 'Not declared')} | ${entry.files.map((file) => `[${basename(file.path)}](${file.path})${file.source ? ` (${markdownText(file.source)})` : ''}`).join(', ') || 'No separate license text shipped by this package; see its declared license.'} |`,
    ),
    '',
    '## Next.js bundled dependencies',
    '',
    'Next.js embeds additional libraries in `dist/compiled`. The following original bundled notices are included separately; these do not appear as independent packages in the pnpm dependency inventory.',
    '',
    ...compiled.map((entry) => `- ${markdownText(entry.source)}: [original text](${entry.path})`),
    '',
  ];
  await writeFile(resolve(output, 'THIRD-PARTY-NOTICES.md'), lines.join('\n'));
  await writeFile(
    resolve(licenseDirectory, 'inventory.json'),
    `${JSON.stringify({ packages, nextCompiledNotices: compiled }, null, 2)}\n`,
  );
  return {
    packageCount: packages.length,
    compiledNoticeCount: compiled.length,
    missingLicenseTexts,
  };
}

export async function writeThirdPartyNotices(target) {
  const command =
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); pnpm licenses list --prod --json; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }';
  const { stdout } = await run(
    process.platform === 'win32' ? 'powershell.exe' : 'pnpm',
    process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : ['licenses', 'list', '--prod', '--json'],
    { cwd: workspace, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  return writeNoticesFromInventory(target, JSON.parse(stdout));
}
