import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { materializeModules } from './standalone.mjs';
import { inventory, workspace } from './files.mjs';

async function fixture(run) {
  const parent = resolve(workspace, '.test-data/standalone-unit');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  if (!root.startsWith(`${parent}${sep}`)) throw new Error('Unsafe test cleanup');
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('relocatable pnpm standalone dependencies', () => {
  it('preserves package dependency lookup after junctions are materialized', async () => {
    await fixture(async (root) => {
      const traced = resolve(root, 'traced');
      const foo = resolve(traced, 'node_modules/.pnpm/foo@1/node_modules/foo');
      const dep = resolve(traced, 'node_modules/.pnpm/dep@1/node_modules/dep');
      const aliases = resolve(traced, 'apps/web/node_modules');
      for (const dir of [foo, dep, aliases]) await mkdir(dir, { recursive: true });
      await writeFile(resolve(foo, 'index.js'), 'module.exports = require("dep");');
      await writeFile(resolve(dep, 'index.js'), 'module.exports = "version-one";');
      await symlink(foo, resolve(aliases, 'foo'), 'junction');
      await symlink(dep, resolve(foo, '../dep'), 'junction');
      const target = resolve(root, 'portable/node_modules');
      await materializeModules(aliases, target, traced);
      const require = createRequire(resolve(root, 'portable/server.cjs'));
      expect(require('foo')).toBe('version-one');
      expect((await inventory(target)).map((file) => file.path)).toContain(
        'foo/node_modules/dep/index.js',
      );
    });
  });
  it('rejects absolute links into the original workspace or other private folders', async () => {
    await fixture(async (root) => {
      const traced = resolve(root, 'traced');
      const aliases = resolve(traced, 'node_modules');
      const external = resolve(root, 'private-package');
      for (const dir of [aliases, external]) await mkdir(dir, { recursive: true });
      await writeFile(resolve(external, 'index.js'), 'private');
      await symlink(external, resolve(aliases, 'external'), 'junction');
      await expect(materializeModules(aliases, resolve(root, 'target'), traced)).rejects.toThrow(
        'outside',
      );
    });
  });
});
