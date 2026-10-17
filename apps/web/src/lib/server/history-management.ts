import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  historyProtections,
  historySummarySchema,
  historyKindSchema,
  type HistoryKind,
  type HistorySummary,
  type ManagedHistoryVersion,
  type Product,
  type ComparisonPlan,
  type AITemplate,
  type ContentPlan,
} from '@productspy/shared';
import { getProductRepository, dataDirectory } from './product-repository';
import { getComparisonRepository } from './comparison-repository';
import { getTemplateRepository } from './template-repository';
import { getContentRepository } from './content-repository';
import { AppError } from './errors';
import { saasEnabled } from '../saas/context';

type Entity = Product | ComparisonPlan | AITemplate | ContentPlan;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const globals = globalThis as typeof globalThis & { __productspyArchiveSecret?: Buffer };
const legacySecret = (globals.__productspyArchiveSecret ??= randomBytes(32));
function archiveSecret(): Buffer {
  if (!saasEnabled()) return legacySecret;
  const configured = process.env.PRODUCTSPY_ARCHIVE_SECRET;
  if (!configured || configured.length < 32)
    throw new AppError(503, '历史清理未配置服务端签名密钥；仍可正常查看和导出');
  return Buffer.from(configured, 'utf8');
}
const signedSchema = z
  .object({
    kind: historyKindSchema,
    id: z.string().min(1).max(100),
    updatedAt: z.string().datetime(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    versionIds: z.array(z.string().uuid()).min(1).max(50),
    expiresAt: z.number().int(),
  })
  .strict();
interface HistoryEntity {
  entity: Entity;
  versions: ManagedHistoryVersion[];
  currentId?: string;
  readOnly: boolean;
  name: string;
}
export async function historyEntity(kind: HistoryKind, id: string): Promise<HistoryEntity> {
  if (kind === 'product') {
    const entity = await getProductRepository().get(id);
    if (!entity) throw new AppError(404, '商品已删除或不存在。');
    const versions = entity.analysisHistory ?? [];
    const current = [...versions]
      .reverse()
      .find(
        (version) =>
          JSON.stringify(version.analysis) === JSON.stringify(entity.aiAnalysis) &&
          JSON.stringify(version.metadata) === JSON.stringify(entity.analysisMetadata),
      );
    return { entity, versions, currentId: current?.id, name: entity.title, readOnly: false };
  }
  if (kind === 'comparison') {
    const entity = await getComparisonRepository().get(id);
    if (!entity) throw new AppError(404, '对比方案已删除或不存在。');
    const versions = entity.analysisHistory ?? [];
    const current = [...versions]
      .reverse()
      .find(
        (version) =>
          JSON.stringify(version.analysis) === JSON.stringify(entity.analysis) &&
          JSON.stringify(version.metadata) === JSON.stringify(entity.analysisMetadata),
      );
    return { entity, versions, currentId: current?.id, name: entity.name, readOnly: false };
  }
  if (kind === 'template') {
    const entity = await getTemplateRepository().get(id);
    if (!entity) throw new AppError(404, '模板已删除或不存在。');
    return {
      entity,
      versions: entity.versions,
      currentId: entity.versions.at(-1)?.id,
      name: entity.name,
      readOnly: entity.origin === 'builtin',
    };
  }
  const entity = await getContentRepository().get(id);
  if (!entity) throw new AppError(404, '内容方案已删除或不存在。');
  return {
    entity,
    versions: entity.versions,
    currentId: entity.currentVersionId,
    name: entity.name,
    readOnly: false,
  };
}
export async function historySummary(kind: HistoryKind, id: string): Promise<HistorySummary> {
  const data = await historyEntity(kind, id);
  const protections = historyProtections(data.versions, data.currentId);
  return historySummarySchema.parse({
    kind,
    id,
    name: data.name,
    updatedAt: data.entity.updatedAt,
    revision: hash(JSON.stringify(data.entity)),
    count: data.versions.length,
    max: 50,
    totalBytes: Buffer.byteLength(JSON.stringify(data.versions)),
    approachingLimit: data.versions.length >= 45,
    readOnly: data.readOnly,
    versions: data.versions.map((version) => ({
      id: version.id,
      kind: version.kind,
      date: version.createdAt,
      bytes: Buffer.byteLength(JSON.stringify(version)),
      protected: data.readOnly || protections.has(version.id),
      reason: data.readOnly ? '内置模板为只读' : (protections.get(version.id) ?? ''),
    })),
  });
}
export async function exportHistoryArchive(input: {
  kind: HistoryKind;
  id: string;
  expectedUpdatedAt: string;
  versionIds: string[];
}): Promise<{ archive: unknown; archiveReceipt: string; sha256: string }> {
  const data = await historyEntity(input.kind, input.id);
  if (data.entity.updatedAt !== input.expectedUpdatedAt)
    throw new AppError(409, '历史资料已经更新，请刷新后重新归档。');
  const selected = new Set(input.versionIds);
  const versions = data.versions.filter((version) => selected.has(version.id));
  if (!versions.length || versions.length !== selected.size)
    throw new AppError(400, '所选历史版本不存在或重复。');
  const archive = {
    format: 'productspy-history-archive',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    kind: input.kind,
    id: input.id,
    revision: hash(JSON.stringify(data.entity)),
    snapshot: data.entity,
    selectedVersionIds: versions.map((version) => version.id),
    selectedVersions: versions,
    instructions:
      '包含完整实体快照和选定历史，供人工恢复参考；不是可直接覆盖同 ID 实体的导入文件。需要自动完整恢复请使用清理前导出的模块或完整业务备份，在独立数据目录恢复。本归档不包含 Key、Cookie 或配对凭据。',
  };
  const sha256 = hash(JSON.stringify(archive));
  if (Buffer.byteLength(JSON.stringify(archive)) > 25 * 1024 * 1024)
    throw new AppError(413, '单项历史归档超过 25 MiB，请使用完整业务备份；没有清理任何资料。');
  const encoded = Buffer.from(
    JSON.stringify({
      kind: input.kind,
      id: input.id,
      updatedAt: data.entity.updatedAt,
      revision: archive.revision,
      scope: hash(dataDirectory()),
      sha256,
      versionIds: archive.selectedVersionIds,
      expiresAt: Date.now() + 30 * 60 * 1000,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', archiveSecret()).update(encoded).digest('base64url');
  return { archive, archiveReceipt: `${encoded}.${signature}`, sha256 };
}
export async function cleanupArchivedHistory(input: {
  kind: HistoryKind;
  id: string;
  expectedUpdatedAt: string;
  versionIds: string[];
  archiveReceipt: string;
  confirmed: true;
}): Promise<{ removed: number; summary: HistorySummary }> {
  const [encoded, signature, extra] = input.archiveReceipt.split('.');
  if (!encoded || !signature || extra) throw new AppError(400, '归档凭证无效，请重新导出历史。');
  const expected = createHmac('sha256', archiveSecret()).update(encoded).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new AppError(400, '归档凭证校验失败，请重新导出；没有清理任何版本。');
  let parsed;
  try {
    parsed = signedSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown,
    );
  } catch {
    throw new AppError(400, '归档凭证格式无效。');
  }
  if (parsed.expiresAt <= Date.now())
    throw new AppError(409, '归档凭证已过期或工作台已重启，请重新导出归档。');
  if (
    parsed.scope !== hash(dataDirectory()) ||
    parsed.kind !== input.kind ||
    parsed.id !== input.id ||
    parsed.updatedAt !== input.expectedUpdatedAt ||
    [...parsed.versionIds].sort().join(',') !== [...input.versionIds].sort().join(',')
  )
    throw new AppError(400, '清理选择与已导出的归档不一致，请重新归档。');
  const summary = await historySummary(input.kind, input.id);
  if (summary.revision !== parsed.revision || summary.updatedAt !== parsed.updatedAt)
    throw new AppError(409, '归档后资料已经变化，请刷新并重新归档；历史未改动。');
  if (summary.readOnly) throw new AppError(403, '内置模板历史不能清理。');
  if (input.kind === 'product')
    await getProductRepository().cleanupHistory(
      input.id,
      input.expectedUpdatedAt,
      input.versionIds,
      parsed.sha256,
      parsed.revision,
    );
  else if (input.kind === 'comparison')
    await getComparisonRepository().cleanupHistory(
      input.id,
      input.expectedUpdatedAt,
      input.versionIds,
      parsed.sha256,
      parsed.revision,
    );
  else if (input.kind === 'template')
    await getTemplateRepository().cleanupHistory(
      input.id,
      input.expectedUpdatedAt,
      input.versionIds,
      parsed.sha256,
      parsed.revision,
    );
  else
    await getContentRepository().cleanupHistory(
      input.id,
      input.expectedUpdatedAt,
      input.versionIds,
      parsed.sha256,
      parsed.revision,
    );
  return { removed: input.versionIds.length, summary: await historySummary(input.kind, input.id) };
}
