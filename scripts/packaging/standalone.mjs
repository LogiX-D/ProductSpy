import { mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { copyPublic } from './files.mjs';

// pnpm's traced Windows junctions point to absolute build paths. Materialize
// each package with its own versioned dependencies, including peer dependencies.
// Flattening alone loses the dependency context of the virtual-store package.
export async function materializeModules(source, destination, tracingRoot, ancestors = new Set()) {
  const allowedRoot = await realpath(tracingRoot);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const origin = resolve(source, entry.name);
    const target = resolve(destination, entry.name);
    if (entry.name.startsWith('@')) {
      await materializeModules(origin, target, tracingRoot, ancestors);
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const actual = await realpath(origin);
    if (!actual.startsWith(`${allowedRoot}${sep}`))
      throw new Error('Traced dependency points outside the standalone build');
    // A cyclic dependency resolves to its existing ancestor through Node lookup.
    if (ancestors.has(actual)) continue;
    await copyPublic(actual, target, ['node_modules']);
    let adjacent = dirname(actual);
    if (basename(adjacent).startsWith('@')) adjacent = dirname(adjacent);
    if (basename(adjacent) !== 'node_modules') throw new Error('Unexpected traced package layout');
    await materializeModules(
      adjacent,
      resolve(target, 'node_modules'),
      tracingRoot,
      new Set([...ancestors, actual]),
    );
  }
}
