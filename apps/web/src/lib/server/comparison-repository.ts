import { publishAtomicFile } from './atomic-file';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  MAX_COMPARISON_BACKUP_BYTES,
  MAX_COMPARISON_PLANS,
  MAX_COMPARISON_VERSIONS,
  comparisonAnalysisSchema,
  comparisonBackupSchema,
  comparisonFileSchema,
  comparisonPlanSchema,
  parseLibraryImport,
  type ComparisonAnalysis,
  type ComparisonAnalysisMetadata,
  type ComparisonPlan,
  type ComparisonAnalysisVersion,
  type Product,
} from '@productspy/shared';
import { AppError } from './errors';
import { dataDirectory } from './product-repository';

interface Registry {
  queues: Map<string, Promise<unknown>>;
  repositories: Map<string, LocalComparisonRepository>;
}
const globalRegistry = globalThis as typeof globalThis & { __productspyComparisons?: Registry };
const registry = (globalRegistry.__productspyComparisons ??= {
  queues: new Map(),
  repositories: new Map(),
});
function updatedAt(previous?: string): string {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}
function validateSnapshots(plans: ComparisonPlan[]): void {
  for (const plan of plans)
    parseLibraryImport(plan.products.map((product) => ({ ...product, groupIds: [], tagIds: [] })));
}
function preservedHistory(plan: ComparisonPlan): ComparisonAnalysisVersion[] {
  const history = [...(plan.analysisHistory ?? [])];
  const last = history.at(-1);
  if (
    plan.analysis &&
    (!last ||
      JSON.stringify(last.analysis) !== JSON.stringify(plan.analysis) ||
      JSON.stringify(last.metadata) !== JSON.stringify(plan.analysisMetadata))
  ) {
    if (history.length >= MAX_COMPARISON_VERSIONS)
      throw new AppError(
        409,
        '当前分析与历史存在尚未归档的内容，已有 50 个版本。请先导出；不会覆盖当前分析。',
      );
    history.push({
      id: randomUUID(),
      createdAt: plan.updatedAt,
      kind: plan.analysisMetadata ? 'generated' : 'edited',
      analysis: plan.analysis,
      ...(plan.analysisMetadata ? { metadata: plan.analysisMetadata } : {}),
    });
  }
  return history;
}
export class LocalComparisonRepository {
  readonly directory: string;
  readonly filePath: string;
  constructor(directory = dataDirectory()) {
    this.directory = resolve(/* turbopackIgnore: true */ directory);
    this.filePath = join(this.directory, 'comparisons.json');
  }
  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const prior = registry.queues.get(this.filePath) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    registry.queues.set(
      this.filePath,
      result.catch(() => undefined),
    );
    return result;
  }
  private async read(): Promise<ComparisonPlan[]> {
    try {
      if ((await stat(this.filePath)).size > MAX_COMPARISON_BACKUP_BYTES)
        throw new Error('Comparison file too large');
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      const file = comparisonFileSchema.parse(parsed);
      validateSnapshots(file.plans);
      return file.plans;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return [];
      console.error('[ProductSpy comparisons] Unable to read comparison file', error);
      throw new AppError(
        500,
        '本地对比方案文件无法读取。请保留 comparisons.json 并检查日志；原商品库未改动。',
      );
    }
  }
  private async write(plans: ComparisonPlan[]): Promise<void> {
    const stored = comparisonFileSchema.parse({ schemaVersion: 1, plans });
    validateSnapshots(stored.plans);
    const text = JSON.stringify(stored, null, 2);
    if (Buffer.byteLength(text) > MAX_COMPARISON_BACKUP_BYTES)
      throw new AppError(413, '对比方案超过 25 MiB。请先导出备份并减少方案数量；原资料未覆盖。');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.comparisons-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await publishAtomicFile(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  list(): Promise<ComparisonPlan[]> {
    return this.transaction(async () =>
      (await this.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }
  get(id: string): Promise<ComparisonPlan | undefined> {
    return this.transaction(async () => (await this.read()).find((plan) => plan.id === id));
  }
  create(name: string, products: Product[]): Promise<ComparisonPlan> {
    return this.transaction(async () => {
      const plans = await this.read();
      if (plans.length >= MAX_COMPARISON_PLANS)
        throw new AppError(409, '最多保存 200 个对比方案。请先备份并整理现有方案。');
      const time = updatedAt();
      const parsed = comparisonPlanSchema.safeParse({
        id: randomUUID(),
        name,
        products,
        createdAt: time,
        updatedAt: time,
        snapshotUpdatedAt: time,
        analysisHistory: [],
      });
      if (!parsed.success)
        throw new AppError(400, parsed.error.issues[0]?.message ?? '对比方案格式无效');
      await this.write([...plans, parsed.data]);
      return parsed.data;
    });
  }
  update(
    id: string,
    input: {
      expectedUpdatedAt: string;
      name?: string;
      productIds?: string[];
      refreshSnapshots?: boolean;
    },
    currentProducts: Product[],
  ): Promise<ComparisonPlan> {
    return this.transaction(async () => {
      const plans = await this.read();
      const plan = this.required(plans, id, input.expectedUpdatedAt);
      const previousSnapshots = JSON.stringify(plan.products);
      if (input.name !== undefined) plan.name = input.name;
      const ids = input.productIds ?? plan.products.map((p) => p.id);
      const snapshots = new Map(plan.products.map((p) => [p.id, p]));
      const current = new Map(currentProducts.map((p) => [p.id, p]));
      plan.products = ids.map((productId) => {
        const existing = snapshots.get(productId);
        const live = current.get(productId);
        const product = input.refreshSnapshots ? (live ?? existing) : (existing ?? live);
        if (!product)
          throw new AppError(
            409,
            '待加入的商品已删除。请刷新商品列表后重试；现有对比方案没有覆盖。',
          );
        return product;
      });
      plan.updatedAt = updatedAt(plan.updatedAt);
      if (JSON.stringify(plan.products) !== previousSnapshots)
        plan.snapshotUpdatedAt = plan.updatedAt;
      const parsed = comparisonPlanSchema.safeParse(plan);
      if (!parsed.success)
        throw new AppError(400, parsed.error.issues[0]?.message ?? '请选择 2–5 个不同的商品');
      await this.write(plans);
      return parsed.data;
    });
  }
  private required(
    plans: ComparisonPlan[],
    id: string,
    expectedUpdatedAt?: string,
  ): ComparisonPlan {
    const plan = plans.find((p) => p.id === id);
    if (!plan) throw new AppError(404, '对比方案已删除或不存在，请刷新方案列表。');
    if (expectedUpdatedAt !== undefined && plan.updatedAt !== expectedUpdatedAt)
      throw new AppError(409, '对比方案已被更新，请刷新后重试；没有覆盖现有内容。');
    return plan;
  }
  assertAnalysisCapacity(id: string, expectedUpdatedAt: string): Promise<void> {
    return this.transaction(async () => {
      const plan = this.required(await this.read(), id, expectedUpdatedAt);
      if (preservedHistory(plan).length >= MAX_COMPARISON_VERSIONS)
        throw new AppError(
          409,
          '此方案已有 50 个分析版本，请先导出历史；不会删除旧内容或发起新的 AI 请求。',
        );
    });
  }
  saveAnalysis(
    id: string,
    analysis: ComparisonAnalysis,
    expectedUpdatedAt: string,
    context: {
      metadata?: ComparisonAnalysisMetadata;
      kind?: 'generated' | 'edited' | 'restored';
      restoredFrom?: string;
    } = {},
  ): Promise<ComparisonPlan> {
    return this.transaction(async () => {
      const plans = await this.read();
      const plan = this.required(plans, id, expectedUpdatedAt);
      const history = preservedHistory(plan);
      if (history.length >= MAX_COMPARISON_VERSIONS)
        throw new AppError(409, '此方案已有 50 个分析版本。请先导出历史；现有内容未改动。');
      const parsed = comparisonAnalysisSchema.safeParse(analysis);
      if (!parsed.success) throw new AppError(400, '对比分析内容缺少字段，请填写全部分区后保存。');
      const metadata =
        context.kind === 'restored'
          ? context.metadata
          : (context.metadata ?? plan.analysisMetadata);
      plan.updatedAt = updatedAt(plan.updatedAt);
      plan.analysis = parsed.data;
      if (metadata) plan.analysisMetadata = metadata;
      else delete plan.analysisMetadata;
      plan.analysisHistory = [
        ...history,
        {
          id: randomUUID(),
          createdAt: plan.updatedAt,
          kind: context.kind ?? 'edited',
          analysis: parsed.data,
          ...(metadata ? { metadata } : {}),
          ...(context.restoredFrom ? { restoredFrom: context.restoredFrom } : {}),
        },
      ];
      await this.write(plans);
      return plan;
    });
  }
  async restoreAnalysis(
    id: string,
    versionId: string,
    expectedUpdatedAt: string,
  ): Promise<ComparisonPlan> {
    const plan = await this.get(id);
    if (!plan) throw new AppError(404, '对比方案不存在');
    const version = plan.analysisHistory?.find((item) => item.id === versionId);
    if (!version) throw new AppError(404, '该分析版本不存在');
    return this.saveAnalysis(id, version.analysis, expectedUpdatedAt, {
      kind: 'restored',
      metadata: version.metadata,
      restoredFrom: versionId,
    });
  }
  delete(id: string, expectedUpdatedAt: string, confirmed: boolean): Promise<void> {
    return this.transaction(async () => {
      if (!confirmed) throw new AppError(400, '删除对比方案需要再次确认');
      const plans = await this.read();
      this.required(plans, id, expectedUpdatedAt);
      await this.write(plans.filter((p) => p.id !== id));
    });
  }
  backup(): Promise<{
    format: 'productspy-comparisons';
    schemaVersion: 1;
    exportedAt: string;
    plans: ComparisonPlan[];
    revision: string;
  }> {
    return this.transaction(async () => {
      const plans = await this.read();
      return {
        format: 'productspy-comparisons',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        plans,
        revision: createHash('sha256').update(JSON.stringify(plans)).digest('hex'),
      };
    });
  }
  importBackup(
    value: unknown,
    input: { commit?: boolean; expectedRevision?: string },
  ): Promise<{
    total: number;
    imported: number;
    skipped: number;
    conflicts: { id: string; name: string }[];
    revision: string;
  }> {
    return this.transaction(async () => {
      let parsed;
      try {
        parsed = comparisonBackupSchema.parse(value);
        validateSnapshots(parsed.plans);
      } catch {
        throw new AppError(
          400,
          '请选择有效的 ProductSpy 对比方案 JSON 备份。地址、历史和商品数据均需通过校验。',
        );
      }
      const plans = await this.read();
      const revision = createHash('sha256').update(JSON.stringify(plans)).digest('hex');
      const ids = new Set(plans.map((p) => p.id));
      const incoming = parsed.plans.filter((p) => !ids.has(p.id));
      const conflicts = parsed.plans
        .filter((p) => ids.has(p.id))
        .map((p) => ({ id: p.id, name: p.name }));
      if (input.commit) {
        if (input.expectedRevision !== revision)
          throw new AppError(409, '对比方案在预览后发生更新，请重新预览备份。');
        if (plans.length + incoming.length > MAX_COMPARISON_PLANS)
          throw new AppError(413, '导入后超过 200 个方案，请减少备份内容。');
        await this.write([...plans, ...incoming]);
      }
      return {
        total: parsed.plans.length,
        imported: input.commit ? incoming.length : 0,
        skipped: conflicts.length,
        conflicts,
        revision,
      };
    });
  }
}
export function getComparisonRepository(): LocalComparisonRepository {
  const directory = dataDirectory();
  let repository = registry.repositories.get(directory);
  if (!repository) {
    repository = new LocalComparisonRepository(directory);
    registry.repositories.set(directory, repository);
  }
  return repository;
}
