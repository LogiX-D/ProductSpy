import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { publishAtomicFile } from './atomic-file';
import { AppError } from './errors';
import { saasEnabled } from '../saas/context';
import { commitWorkspaceDocuments } from '../saas/workspace-storage';

export const BUSINESS_FILES = [
  'products.json',
  'comparisons.json',
  'templates.json',
  'content-plans.json',
  'analysis-usage.json',
] as const;
export type BusinessFile = (typeof BUSINESS_FILES)[number];
const stageName = '.workspace-restore';
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const entrySchema = z
  .object({
    name: z.enum(BUSINESS_FILES),
    oldHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    newHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.enum(['staging', 'prepared', 'committed', 'rolled-back']),
    entries: z.array(entrySchema).length(BUSINESS_FILES.length),
  })
  .strict()
  .refine(
    (value) => new Set(value.entries.map((item) => item.name)).size === BUSINESS_FILES.length,
  );
interface Waiter {
  exclusive: boolean;
  grant: () => void;
}
interface Gate {
  readers: number;
  writer: boolean;
  waiting: Waiter[];
}
interface Registry {
  gates: Map<string, Gate>;
  context: AsyncLocalStorage<Map<string, 'shared' | 'exclusive'>>;
}
const globals = globalThis as typeof globalThis & { __productspyBusinessGate?: Registry };
const registry = (globals.__productspyBusinessGate ??= {
  gates: new Map(),
  context: new AsyncLocalStorage(),
});

function pump(gate: Gate): void {
  if (gate.writer) return;
  while (gate.waiting.length) {
    const next = gate.waiting[0];
    if (next.exclusive) {
      if (gate.readers) return;
      gate.waiting.shift();
      gate.writer = true;
      next.grant();
      return;
    }
    gate.waiting.shift();
    gate.readers++;
    next.grant();
  }
}
async function acquire(directory: string, exclusive: boolean): Promise<() => void> {
  let gate = registry.gates.get(directory);
  if (!gate) {
    gate = { readers: 0, writer: false, waiting: [] };
    registry.gates.set(directory, gate);
  }
  const selected = gate;
  await new Promise<void>((grant) => {
    selected.waiting.push({ exclusive, grant });
    pump(selected);
  });
  return () => {
    if (exclusive) selected.writer = false;
    else selected.readers--;
    pump(selected);
  };
}
async function optionalRead(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 25 * 1024 * 1024)
      throw new Error('Unexpected business file type or size');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}
async function cleanupStage(directory: string): Promise<void> {
  const target = resolve(join(directory, stageName));
  if (target !== join(directory, stageName)) throw new Error('Invalid restore stage path');
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe restore stage');
  const allowed = new Set([
    'journal.json',
    'journal-next.json',
    ...BUSINESS_FILES.flatMap((name) => [
      `old-${name}`,
      `new-${name}`,
      `publish-${name}`,
      `rollback-${name}`,
    ]),
  ]);
  const names = await readdir(target);
  if (names.some((name) => !allowed.has(name))) throw new Error('Unknown restore stage file');
  // Keep the committed/rolled-back marker until every expendable copy is removed.
  for (const name of names.filter((name) => name !== 'journal.json')) {
    const file = join(target, name);
    const item = await lstat(file);
    if (!item.isFile() || item.isSymbolicLink()) throw new Error('Unsafe restore stage file');
    await unlink(file);
  }
  if (names.includes('journal.json')) await unlink(join(target, 'journal.json'));
  await rmdir(target);
}
/** Recovery runs before ordinary reads/writes, so a crashed multi-file restore is never visible. */
export async function recoverBusinessRestore(directoryInput: string): Promise<void> {
  if (saasEnabled()) return;
  const directory = resolve(directoryInput);
  const stage = join(directory, stageName);
  try {
    const info = await lstat(stage);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe restore stage');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw new AppError(500, '业务恢复日志异常。请保留用户数据目录；尚未覆盖或清空任何资料。');
  }
  try {
    if ((await readdir(stage)).length === 0) {
      await cleanupStage(directory);
      return;
    }
    const journalText = await optionalRead(join(stage, 'journal.json'));
    if (!journalText) throw new Error('Missing restore journal');
    const journal = journalSchema.parse(JSON.parse(journalText) as unknown);
    // Validate every recovery byte and every current file before changing even one file.
    const oldFiles = new Map<BusinessFile, string | undefined>();
    for (const entry of journal.entries) {
      const current = await optionalRead(join(directory, entry.name));
      const hash = current === undefined ? null : digest(current);
      if (journal.phase === 'committed') {
        if (hash !== entry.newHash) throw new Error('Committed restore was modified');
      } else if (journal.phase === 'rolled-back' || journal.phase === 'staging') {
        if (hash !== entry.oldHash) throw new Error('Rolled-back restore was modified');
      } else {
        if (hash !== entry.oldHash && hash !== entry.newHash)
          throw new Error('Unknown current business revision');
        const old = await optionalRead(join(stage, `old-${entry.name}`));
        if ((old === undefined ? null : digest(old)) !== entry.oldHash)
          throw new Error('Recovery copy mismatch');
        oldFiles.set(entry.name, old);
      }
      if (journal.phase === 'prepared') {
        const next = await optionalRead(join(stage, `new-${entry.name}`));
        if (next === undefined || digest(next) !== entry.newHash)
          throw new Error('Restore stage mismatch');
      }
    }
    if (journal.phase === 'prepared') {
      for (const entry of journal.entries) {
        const old = oldFiles.get(entry.name);
        if (old === undefined)
          await unlink(join(directory, entry.name)).catch((error: unknown) => {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
              throw error;
          });
        else {
          const temporary = join(stage, `rollback-${entry.name}`);
          await writeFile(temporary, old, { mode: 0o600 });
          await publishAtomicFile(temporary, join(directory, entry.name));
        }
      }
    }
    if (journal.phase === 'prepared' || journal.phase === 'staging') {
      await writeFile(
        join(stage, 'journal-next.json'),
        JSON.stringify({ ...journal, phase: 'rolled-back' }),
        { mode: 0o600 },
      );
      await publishAtomicFile(join(stage, 'journal-next.json'), join(stage, 'journal.json'));
    }
    await cleanupStage(directory);
  } catch (error) {
    console.error('[ProductSpy business restore] Recovery blocked', error);
    throw new AppError(
      500,
      '业务恢复尚未完成或日志损坏。请保留 .workspace-restore 与原资料并检查日志；为保护数据，暂不继续读写。',
    );
  }
}
export async function withBusinessExclusive<T>(
  directoryInput: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (saasEnabled()) return operation();
  const directory = resolve(directoryInput);
  if (registry.context.getStore()?.has(directory))
    throw new Error('Exclusive business restore cannot be nested inside a normal operation');
  const release = await acquire(directory, true);
  try {
    await recoverBusinessRestore(directory);
    const inherited = new Map(registry.context.getStore());
    inherited.set(directory, 'exclusive');
    return await registry.context.run(inherited, operation);
  } finally {
    release();
  }
}
export async function withBusinessOperation<T>(
  directoryInput: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (saasEnabled()) return operation();
  const directory = resolve(directoryInput);
  if (registry.context.getStore()?.has(directory)) return operation();
  // Exclusive recovery precedes each shared grant; fair queueing prevents restore starvation.
  await withBusinessExclusive(directory, async () => undefined);
  const release = await acquire(directory, false);
  try {
    const inherited = new Map(registry.context.getStore());
    inherited.set(directory, 'shared');
    return await registry.context.run(inherited, operation);
  } finally {
    release();
  }
}
/** Called only inside the exclusive gate. Recovery copies survive a process crash. */
export async function commitBusinessFiles(
  directoryInput: string,
  files: Record<BusinessFile, string>,
  publish: (source: string, destination: string) => Promise<void> = publishAtomicFile,
): Promise<void> {
  if (saasEnabled()) return commitWorkspaceDocuments(directoryInput, files);
  const directory = resolve(directoryInput);
  if (registry.context.getStore()?.get(directory) !== 'exclusive')
    throw new Error('Restore requires business gate');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries: z.infer<typeof entrySchema>[] = [];
  const originals = new Map<BusinessFile, string | undefined>();
  for (const name of BUSINESS_FILES) {
    const old = await optionalRead(join(/* turbopackIgnore: true */ directory, name));
    originals.set(name, old);
    entries.push({
      name,
      oldHash: old === undefined ? null : digest(old),
      newHash: digest(files[name]),
    });
  }
  const stage = join(directory, stageName);
  await mkdir(stage, { mode: 0o700 });
  let journalStarted = false;
  try {
    await writeFile(
      join(stage, 'journal.json'),
      JSON.stringify({ schemaVersion: 1, phase: 'staging', entries }),
      { flag: 'wx', mode: 0o600 },
    );
    journalStarted = true;
    for (const name of BUSINESS_FILES) {
      const old = originals.get(name);
      if (old !== undefined)
        await writeFile(join(stage, `old-${name}`), old, { flag: 'wx', mode: 0o600 });
      await writeFile(join(stage, `new-${name}`), files[name], { flag: 'wx', mode: 0o600 });
    }
    await writeFile(
      join(stage, 'journal-next.json'),
      JSON.stringify({ schemaVersion: 1, phase: 'prepared', entries }),
      { flag: 'wx', mode: 0o600 },
    );
    await publishAtomicFile(join(stage, 'journal-next.json'), join(stage, 'journal.json'));
    for (const name of BUSINESS_FILES) {
      const temporary = join(stage, `publish-${name}`);
      await writeFile(temporary, files[name], { flag: 'wx', mode: 0o600 });
      await publish(temporary, join(/* turbopackIgnore: true */ directory, name));
    }
    await writeFile(
      join(stage, 'journal-next.json'),
      JSON.stringify({ schemaVersion: 1, phase: 'committed', entries }),
      { flag: 'wx', mode: 0o600 },
    );
    await publishAtomicFile(join(stage, 'journal-next.json'), join(stage, 'journal.json'));
    await cleanupStage(directory);
  } catch (error) {
    if (journalStarted) await recoverBusinessRestore(directory);
    else await cleanupStage(directory);
    throw error;
  }
}
