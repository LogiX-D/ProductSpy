import { z } from 'zod';

export const historyKindSchema = z.enum(['product', 'comparison', 'template', 'content']);
export type HistoryKind = z.infer<typeof historyKindSchema>;
export interface ManagedHistoryVersion {
  id: string;
  createdAt: string;
  kind: string;
  parentVersionId?: string;
  restoredFrom?: string;
  archivedParentVersionId?: string;
  archivedParentSha256?: string;
}
export const historySummarySchema = z.object({
  kind: historyKindSchema,
  id: z.string().min(1).max(100),
  name: z.string().max(1000),
  updatedAt: z.string().datetime(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  count: z.number().int().min(0).max(50),
  max: z.literal(50),
  totalBytes: z.number().int().nonnegative(),
  approachingLimit: z.boolean(),
  readOnly: z.boolean(),
  versions: z
    .array(
      z.object({
        id: z.string().uuid(),
        kind: z.string(),
        date: z.string().datetime(),
        bytes: z.number().int().nonnegative(),
        protected: z.boolean(),
        reason: z.string(),
      }),
    )
    .max(50),
});
export type HistorySummary = z.infer<typeof historySummarySchema>;
export const historySelectionSchema = z
  .object({
    kind: historyKindSchema,
    id: z.string().min(1).max(100),
    expectedUpdatedAt: z.string().datetime(),
    versionIds: z
      .array(z.string().uuid())
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, '历史版本选择不能重复'),
  })
  .strict();
export const historyCleanupSchema = historySelectionSchema
  .extend({
    confirmed: z.literal(true),
    archiveReceipt: z.string().min(40).max(12000),
  })
  .strict();

/** Preserve the first recovery node, current result and every existing restore dependency.
 * Descriptive parent links are not restore dependencies: their original lineage can be archived.
 */
export function historyProtections(
  versions: readonly ManagedHistoryVersion[],
  currentId?: string,
): Map<string, string> {
  const protectedIds = new Map<string, string>();
  if (versions[0]) protectedIds.set(versions[0].id, '最初恢复节点');
  if (currentId) protectedIds.set(currentId, '当前使用版本');
  else if (versions.at(-1)) protectedIds.set(versions.at(-1)!.id, '最近恢复节点');
  for (const version of versions) {
    if (version.restoredFrom && versions.some((source) => source.id === version.restoredFrom))
      protectedIds.set(version.restoredFrom, '已保存恢复版本的来源');
  }
  return protectedIds;
}

export function cleanupHistoryVersions<T extends ManagedHistoryVersion>(
  versions: readonly T[],
  currentId: string | undefined,
  versionIds: readonly string[],
  archiveSha256: string,
): T[] {
  if (
    !versionIds.length ||
    versionIds.length > 50 ||
    new Set(versionIds).size !== versionIds.length
  )
    throw new Error('请选择 1–50 个不同的历史版本。');
  if (!/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error('请先导出有效的历史归档。');
  const protectedIds = historyProtections(versions, currentId);
  const existing = new Set(versions.map((version) => version.id));
  for (const id of versionIds) {
    if (!existing.has(id)) throw new Error('所选历史版本已变化，请刷新后重新归档。');
    const reason = protectedIds.get(id);
    if (reason) throw new Error(`不能清理受保护版本：${reason}。`);
  }
  const selected = new Set(versionIds);
  return versions
    .filter((version) => !selected.has(version.id))
    .map((version) => {
      if (!version.parentVersionId || !selected.has(version.parentVersionId)) return { ...version };
      const { parentVersionId, ...retained } = version;
      return {
        ...retained,
        archivedParentVersionId: parentVersionId,
        archivedParentSha256: archiveSha256,
      } as T;
    });
}
