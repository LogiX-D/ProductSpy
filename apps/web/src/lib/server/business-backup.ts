import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  comparisonFileSchema,
  contentFileSchema,
  libraryFileSchema,
  mergeLibraryImport,
  productSchema,
  templateFileSchema,
} from '@productspy/shared';
import {
  MAX_WORKSPACE_FILE_BYTES,
  parseWorkspaceBackup,
  validateWorkspaceRelations,
  workspaceBackupCounts,
  workspaceFileContents,
  workspaceUsageSchema,
  type WorkspaceBackup,
  type WorkspaceBackupPreview,
} from '@productspy/shared';
import { AppError } from './errors';
import {
  BUSINESS_FILES,
  commitBusinessFiles,
  withBusinessExclusive,
  type BusinessFile,
} from './business-lock';
import { dataDirectory } from './product-repository';
import { saasEnabled } from '../saas/context';
import { readWorkspaceDocument } from '../saas/workspace-storage';
import { parseStoredAnalysisUsage, type UsageRecord } from './analysis-usage';

interface State {
  backup: WorkspaceBackup;
  // Server-only decisions never enter the portable, client-controlled backup format.
  internalUsage: UsageRecord[];
  revision: string;
  bytes: number;
}
async function readState(directory: string): Promise<State> {
  const source: Partial<Record<BusinessFile, string>> = {};
  for (const name of BUSINESS_FILES) {
    try {
      if (saasEnabled()) {
        source[name] = await readWorkspaceDocument(directory, name);
        if (Buffer.byteLength(source[name]) > MAX_WORKSPACE_FILE_BYTES)
          throw new Error(`Invalid document ${name}`);
        continue;
      }
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_WORKSPACE_FILE_BYTES)
        throw new Error(`Invalid file ${name}`);
      source[name] = await readFile(path, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        continue;
      throw error;
    }
  }
  const value = (name: BusinessFile): unknown =>
    source[name] === undefined ? undefined : JSON.parse(source[name]);
  const rawLibrary = value('products.json');
  const library =
    rawLibrary === undefined
      ? { products: [], groups: [], tags: [] }
      : Array.isArray(rawLibrary)
        ? { products: productSchema.strict().array().parse(rawLibrary), groups: [], tags: [] }
        : libraryFileSchema.parse(rawLibrary);
  const internalUsage =
    source['analysis-usage.json'] === undefined
      ? []
      : parseStoredAnalysisUsage(value('analysis-usage.json'));
  const backup = parseWorkspaceBackup({
    format: 'productspy-workspace',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    library: { products: library.products, groups: library.groups, tags: library.tags },
    comparisons:
      source['comparisons.json'] === undefined
        ? []
        : comparisonFileSchema.parse(value('comparisons.json')).plans,
    templates:
      source['templates.json'] === undefined
        ? []
        : templateFileSchema.parse(value('templates.json')).templates,
    contentPlans:
      source['content-plans.json'] === undefined
        ? []
        : contentFileSchema.parse(value('content-plans.json')).plans,
    usage: workspaceUsageSchema.parse(
      internalUsage.map((record) => {
        const portable = { ...record };
        delete portable.execution;
        return portable;
      }),
    ),
  });
  const revision = createHash('sha256')
    .update(JSON.stringify(BUSINESS_FILES.map((name) => [name, source[name] ?? null])))
    .digest('hex');
  return {
    backup,
    internalUsage,
    revision,
    bytes: Object.values(source).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  };
}
function preview(incoming: WorkspaceBackup, current: State): WorkspaceBackupPreview {
  validateWorkspaceRelations(incoming, current.backup);
  const conflicts: WorkspaceBackupPreview['conflicts'] = [];
  const products = new Map(
    current.backup.library.products.map((item) => [`${item.source}:${item.sourceId}`, item]),
  );
  for (const product of incoming.library.products)
    if (products.has(`${product.source}:${product.sourceId}`))
      conflicts.push({
        kind: 'product',
        id: product.id,
        label: `${product.title} (${product.sourceId})`,
      });
  for (const [kind, incomingItems, existingItems] of [
    ['comparison', incoming.comparisons, current.backup.comparisons],
    ['template', incoming.templates, current.backup.templates],
    ['content', incoming.contentPlans, current.backup.contentPlans],
  ] as const) {
    const ids = new Set(existingItems.map((item) => item.id));
    for (const item of incomingItems)
      if (ids.has(item.id)) conflicts.push({ kind, id: item.id, label: item.name });
  }
  const requests = new Map(current.backup.usage.map((item) => [item.requestId, item]));
  for (const record of incoming.usage) {
    const previous = requests.get(record.requestId);
    if (!previous) continue;
    if (
      previous.fingerprint !== record.fingerprint ||
      previous.productId !== record.productId ||
      previous.mode !== record.mode
    )
      throw new AppError(
        409,
        '同一 AI 请求编号对应不同请求，恢复已取消；现有计费与防重复记录保持不变。',
      );
    conflicts.push({
      kind: 'usage',
      id: record.requestId,
      label: `AI 用量 ${record.requestId.slice(0, 8)}`,
    });
  }
  const liveProducts = new Set(incoming.library.products.map((item) => item.id));
  const detached = incoming.contentPlans.filter((item) => !liveProducts.has(item.productId)).length;
  return {
    revision: current.revision,
    counts: workspaceBackupCounts(incoming),
    conflicts,
    warnings: [
      '重复记录只会跳过或保留本机已有资料；现有商品、人工编辑与历史不会被覆盖。',
      'AI 用量与请求指纹合并后保留全部本机记录；不会恢复成新请求或自动调用 AI。',
      ...(detached ? [`${detached} 个内容方案的源商品不在备份商品库，已验证其独立来源快照。`] : []),
      ...(incoming.preferences
        ? ['可选浏览器偏好需要另行勾选恢复；不含 Cookie、配对信息或 Key。']
        : []),
    ],
  };
}
export class WorkspaceBackupService {
  readonly directory: string;
  constructor(directory = dataDirectory()) {
    this.directory = resolve(directory);
  }
  export(): Promise<WorkspaceBackup> {
    return withBusinessExclusive(this.directory, async () => {
      try {
        return (await readState(this.directory)).backup;
      } catch (error) {
        console.error('[ProductSpy workspace backup] Export blocked', error);
        throw new AppError(
          500,
          '完整业务资料无法读取或超出容量；原始文件已保留，请检查日志或使用独立备份。',
        );
      }
    });
  }
  status(): Promise<{
    counts: ReturnType<typeof workspaceBackupCounts>;
    revision: string;
    bytes: number;
  }> {
    return withBusinessExclusive(this.directory, async () => {
      const state = await readState(this.directory);
      return {
        counts: workspaceBackupCounts(state.backup),
        revision: state.revision,
        bytes: state.bytes,
      };
    });
  }
  async restore(
    value: unknown,
    options: {
      commit?: boolean;
      confirmed?: boolean;
      policy?: 'skip' | 'preserve';
      expectedRevision?: string;
    },
  ): Promise<{
    preview: WorkspaceBackupPreview;
    committed: boolean;
    imported?: number;
    skipped?: number;
    preferences?: WorkspaceBackup['preferences'];
  }> {
    let incoming: WorkspaceBackup;
    try {
      incoming = parseWorkspaceBackup(value);
    } catch (error) {
      throw new AppError(400, error instanceof Error ? error.message : '备份格式无效');
    }
    return withBusinessExclusive(this.directory, async () => {
      const current = await readState(this.directory);
      let result: WorkspaceBackupPreview;
      try {
        result = preview(incoming, current);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(409, error instanceof Error ? error.message : '备份引用冲突');
      }
      if (
        options.commit &&
        (!options.confirmed ||
          !['skip', 'preserve'].includes(options.policy ?? '') ||
          !options.expectedRevision)
      )
        throw new AppError(400, '请先查看恢复预览、选择保留已有资料并再次确认。');
      if (options.commit && options.expectedRevision !== current.revision)
        throw new AppError(409, '业务资料在预览后已发生变化，请重新预览；没有覆盖任何文件。');
      const mergedLibrary = mergeLibraryImport(
        incoming.library,
        current.backup.library,
        options.policy ?? 'skip',
        randomUUID,
      );
      const merge = <T extends { id: string }>(oldItems: T[], newItems: T[]): T[] => {
        const ids = new Set(oldItems.map((item) => item.id));
        return [...oldItems, ...newItems.filter((item) => !ids.has(item.id))];
      };
      const requestIds = new Set(current.backup.usage.map((item) => item.requestId));
      let combined: WorkspaceBackup;
      try {
        combined = parseWorkspaceBackup({
          ...current.backup,
          library: mergedLibrary.snapshot,
          comparisons: merge(current.backup.comparisons, incoming.comparisons),
          templates: merge(current.backup.templates, incoming.templates),
          contentPlans: merge(current.backup.contentPlans, incoming.contentPlans),
          usage: [
            ...current.backup.usage,
            ...incoming.usage.filter((record) => !requestIds.has(record.requestId)),
          ],
        });
      } catch (error) {
        throw new AppError(
          409,
          error instanceof Error ? error.message : '恢复后超过容量；原资料未覆盖',
        );
      }
      result.warnings.push(
        `分组与标签按名称安全合并：新增 ${mergedLibrary.result.groupsAdded} 个分组、${mergedLibrary.result.tagsAdded} 个标签，已有定义保留原内容。`,
      );
      const mergedProductIds = new Set(combined.library.products.map((product) => product.id));
      const existingContentIds = new Set(current.backup.contentPlans.map((plan) => plan.id));
      const detachedNewContent = incoming.contentPlans.filter(
        (plan) => !existingContentIds.has(plan.id) && !mergedProductIds.has(plan.productId),
      ).length;
      if (detachedNewContent)
        result.warnings.push(
          `${detachedNewContent} 个新增内容方案在安全去重后使用独立商品快照（源商品已删除或同 ASIN 使用不同 ID）。原始商品 ID、ASIN 与历史已保留，不自动改写来源。`,
        );
      // Validate the merged counts, bytes and cross-file references during preview as well.
      if (!options.commit) return { preview: result, committed: false };
      const files = workspaceFileContents(combined) as Record<BusinessFile, string>;
      // Preserve only decisions already held by this server for the exact same
      // request. Imported records cannot supply an execution or create a new call.
      const originalUsage = new Map(
        current.internalUsage.map((record) => [record.requestId, record]),
      );
      files['analysis-usage.json'] = JSON.stringify(
        combined.usage.map((record) => {
          const original = originalUsage.get(record.requestId);
          return original?.execution &&
            original.fingerprint === record.fingerprint &&
            original.productId === record.productId &&
            original.mode === record.mode
            ? { ...record, execution: original.execution }
            : record;
        }),
        null,
        2,
      );
      if (Buffer.byteLength(files['analysis-usage.json']) > MAX_WORKSPACE_FILE_BYTES)
        throw new AppError(409, '恢复后的用量及内部防重复记录超过容量；原资料未覆盖。');
      try {
        await commitBusinessFiles(this.directory, files);
      } catch (error) {
        if (error instanceof AppError) throw error;
        console.error('[ProductSpy workspace backup] Restore rolled back', error);
        throw new AppError(
          500,
          '恢复未能确认完成，原始资料或恢复日志已保留。请检查磁盘空间与权限，重新预览后再试；不会自动重复恢复。',
        );
      }
      const incomingCount =
        incoming.library.products.length +
        incoming.comparisons.length +
        incoming.templates.length +
        incoming.contentPlans.length +
        incoming.usage.length +
        incoming.library.groups.length +
        incoming.library.tags.length;
      const imported =
        incoming.library.products.length +
        incoming.comparisons.length +
        incoming.templates.length +
        incoming.contentPlans.length +
        incoming.usage.length -
        result.conflicts.length +
        mergedLibrary.result.groupsAdded +
        mergedLibrary.result.tagsAdded;
      return {
        preview: result,
        committed: true,
        imported,
        skipped: incomingCount - imported,
        ...(incoming.preferences ? { preferences: incoming.preferences } : {}),
      };
    });
  }
}
