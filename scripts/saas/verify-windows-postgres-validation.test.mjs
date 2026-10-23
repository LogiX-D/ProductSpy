import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateOwnedWindowsCluster } from './verify-windows-postgres-validation.mjs';

describe('portable PostgreSQL cluster cleanup boundary', () => {
  const root = resolve(tmpdir(), 'productspy-portable-pg-validation');
  const runId = randomUUID();
  const directory = join(root, runId);
  const cluster = join(directory, 'cluster');
  const marker = { runId, cluster };
  const check = (changes = {}) =>
    validateOwnedWindowsCluster(
      changes.root ?? root,
      changes.directory ?? directory,
      changes.cluster ?? cluster,
      changes.marker ?? marker,
      changes.runId ?? runId,
    );

  it('accepts only the exact marked cluster from this run', () => {
    expect(() => check()).not.toThrow();
  });
  it('rejects the evidence root and an adjacent prefix directory', () => {
    expect(() => check({ directory: root })).toThrow();
    expect(() => check({ directory: join(`${root}-other`, runId) })).toThrow();
  });
  it('rejects traversal and sibling data directories', () => {
    expect(() => check({ cluster: resolve(directory, '../other-cluster') })).toThrow();
    expect(() => check({ cluster: join(directory, 'another-cluster') })).toThrow();
  });
  it('rejects a different owner and changed cluster marker', () => {
    expect(() => check({ marker: { ...marker, runId: randomUUID() } })).toThrow();
    expect(() => check({ marker: { ...marker, cluster: root } })).toThrow();
  });
  it('rejects a missing marker, relative paths, and malformed run IDs', () => {
    expect(() => check({ marker: {} })).toThrow();
    expect(() => check({ root: 'relative-root' })).toThrow();
    expect(() => check({ runId: '../outside' })).toThrow();
  });
});
