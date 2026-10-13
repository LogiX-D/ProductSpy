import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { workspace } from './files.mjs';
import { writeNoticesFromInventory } from './notices.mjs';

const testRoot = resolve(tmpdir(), 'productspy-license-notices');
const temporary = [];

async function fixture() {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(`${testRoot}${sep}run-`);
  temporary.push(root);
  const dependencies = resolve(root, 'dependencies');
  await mkdir(dependencies);
  return { root, dependencies, output: resolve(root, 'output') };
}

async function dependency(root, name, version = '1.0.0') {
  const directory = resolve(root, name.replaceAll('/', '_'));
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'package.json'),
    JSON.stringify({ name, version, license: 'MIT', irrelevantLocalPath: workspace }),
  );
  return directory;
}

afterEach(async () => {
  for (const path of temporary.splice(0)) {
    if (!resolve(path).startsWith(`${testRoot}${sep}`)) throw new Error('Unsafe test cleanup');
    await rm(path, { recursive: true, force: true });
  }
});

describe('third-party notices', () => {
  it('copies exact license texts and bundled Next notices without machine paths or private files', async () => {
    const { dependencies, output } = await fixture();
    const next = await dependency(dependencies, 'next', '16.4.0');
    await writeFile(resolve(next, 'LICENSE.md'), 'Original next license text\n');
    await writeFile(resolve(next, '.env'), 'PRIVATE_CONFIGURATION');
    const compiled = resolve(next, 'dist/compiled/@scope/module');
    await mkdir(compiled, { recursive: true });
    await writeFile(resolve(compiled, 'LICENSE'), 'Original bundled dependency license\n');
    await writeFile(resolve(compiled, 'index.js'), 'COMPILED_CODE_MUST_NOT_BE_COPIED');
    const result = await writeNoticesFromInventory(
      output,
      { MIT: [{ paths: [next], license: 'MIT' }] },
      dependencies,
    );
    expect(result).toEqual({ packageCount: 1, compiledNoticeCount: 1, missingLicenseTexts: [] });
    const notices = await readFile(resolve(output, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    const index = await readFile(resolve(output, 'licenses/inventory.json'), 'utf8');
    expect(notices).toContain('next 16.4.0 / dist/compiled/@scope/module/LICENSE');
    expect(notices).not.toContain(workspace);
    expect(index).not.toContain(dependencies);
    expect((await readdir(resolve(output, 'licenses/next-16.4.0'))).sort()).toEqual([
      'LICENSE.md',
      'compiled',
    ]);
    expect(
      await readFile(
        resolve(output, 'licenses/next-16.4.0/compiled/@scope/module/LICENSE'),
        'utf8',
      ),
    ).toBe('Original bundled dependency license\n');
  });

  it('deduplicates installed peer copies and explicitly reports missing original license texts', async () => {
    const { dependencies, output } = await fixture();
    const module = await dependency(dependencies, '@example/module');
    const result = await writeNoticesFromInventory(
      output,
      { MIT: [{ paths: [module, module], license: 'MIT' }] },
      dependencies,
    );
    expect(result.packageCount).toBe(1);
    expect(result.missingLicenseTexts).toEqual(['@example/module@1.0.0']);
    expect(await readFile(resolve(output, 'THIRD-PARTY-NOTICES.md'), 'utf8')).toContain(
      'No separate license text shipped by this package',
    );
  });

  it('preserves README license sections and the upstream project text when tarballs omit it', async () => {
    const { dependencies, output } = await fixture();
    const module = await dependency(dependencies, 'isarray');
    await writeFile(
      resolve(module, 'README.md'),
      '# Instructions\nDo not distribute this unrelated section.\n\n## License\nCopyright Example\nPermission granted.\n\n## Development\nDo not include this.\n',
    );
    const next = await dependency(dependencies, 'next');
    await writeFile(resolve(next, 'LICENSE-MIT.txt'), 'Original project copyright and license');
    await mkdir(resolve(next, 'dist/compiled'), { recursive: true });
    const nextEnv = await dependency(dependencies, '@next/env');
    const result = await writeNoticesFromInventory(
      output,
      { MIT: [{ paths: [module, next, nextEnv], license: 'MIT' }] },
      dependencies,
    );
    expect(result.missingLicenseTexts).toEqual([]);
    const extracted = await readFile(
      resolve(output, 'licenses/isarray-1.0.0/LICENSE-README.md'),
      'utf8',
    );
    expect(extracted).toContain('Copyright Example');
    expect(extracted).not.toContain('Development');
    expect(extracted).not.toContain('Instructions');
    expect(
      await readFile(resolve(output, 'licenses/next_env-1.0.0/UPSTREAM-LICENSE.md'), 'utf8'),
    ).toBe('Original project copyright and license');
  });

  it('rejects dependency paths outside the allowed source tree', async () => {
    const { root, dependencies, output } = await fixture();
    const outside = await dependency(root, 'outside');
    await expect(
      writeNoticesFromInventory(output, { MIT: [{ paths: [outside] }] }, dependencies),
    ).rejects.toThrow('outside the dependency directory');
  });
});
