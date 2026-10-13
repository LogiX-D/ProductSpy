import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cleanupHistoryVersions,
  historyProtections,
  historySelectionSchema,
  type ManagedHistoryVersion,
} from './history-management';

function chain(count: number): ManagedHistoryVersion[] {
  const versions: ManagedHistoryVersion[] = [];
  for (let index = 0; index < count; index++)
    versions.push({
      id: randomUUID(),
      createdAt: new Date(index * 1000).toISOString(),
      kind: index % 2 ? 'edited' : 'generated',
      ...(versions.at(-1) ? { parentVersionId: versions.at(-1)!.id } : {}),
    });
  return versions;
}
describe('explicit history capacity cleanup', () => {
  it('keeps first and current while descriptive parent chains can free capacity', () => {
    const versions = chain(50),
      current = versions.at(-1)!;
    const removed = versions.slice(1, 45).map((version) => version.id);
    const remaining = cleanupHistoryVersions(versions, current.id, removed, 'a'.repeat(64));
    expect(remaining).toHaveLength(6);
    expect(remaining[0]).toEqual(versions[0]);
    expect(remaining.at(-1)).toEqual(current);
    expect(remaining[1]?.archivedParentVersionId).toBe(versions[44]?.id);
    expect(remaining[1]?.archivedParentSha256).toBe('a'.repeat(64));
    expect(remaining[1]?.parentVersionId).toBeUndefined();
    expect(versions).toHaveLength(50);
    expect(versions[45]?.parentVersionId).toBe(versions[44]?.id);
  });
  it('protects restore dependency nodes without protecting every parent', () => {
    const versions = chain(6);
    versions[5]!.restoredFrom = versions[2]!.id;
    const protectedIds = historyProtections(versions, versions[4]!.id);
    expect(protectedIds.has(versions[0]!.id)).toBe(true);
    expect(protectedIds.has(versions[2]!.id)).toBe(true);
    expect(protectedIds.has(versions[4]!.id)).toBe(true);
    expect(protectedIds.has(versions[1]!.id)).toBe(false);
    expect(() =>
      cleanupHistoryVersions(versions, versions[4]!.id, [versions[2]!.id], 'b'.repeat(64)),
    ).toThrow('受保护');
  });
  it('never chooses or deletes edits automatically and rejects invalid selections', () => {
    const versions = chain(4);
    expect(() => cleanupHistoryVersions(versions, versions[3]!.id, [], 'a'.repeat(64))).toThrow();
    expect(() =>
      cleanupHistoryVersions(
        versions,
        versions[3]!.id,
        [versions[1]!.id, versions[1]!.id],
        'a'.repeat(64),
      ),
    ).toThrow();
    expect(() =>
      cleanupHistoryVersions(versions, versions[3]!.id, [randomUUID()], 'a'.repeat(64)),
    ).toThrow();
    expect(() =>
      cleanupHistoryVersions(versions, versions[3]!.id, [versions[1]!.id], 'fake'),
    ).toThrow();
    expect(
      cleanupHistoryVersions(versions, versions[3]!.id, [versions[2]!.id], 'a'.repeat(64)).some(
        (version) => version.id === versions[1]!.id,
      ),
    ).toBe(true);
  });
  it('selection schema requires unique IDs and valid revision timestamp', () => {
    const id = randomUUID();
    expect(
      historySelectionSchema.safeParse({
        kind: 'product',
        id,
        expectedUpdatedAt: 'yesterday',
        versionIds: [id],
      }).success,
    ).toBe(false);
    expect(
      historySelectionSchema.safeParse({
        kind: 'content',
        id,
        expectedUpdatedAt: new Date().toISOString(),
        versionIds: [id, id],
      }).success,
    ).toBe(false);
  });
});
