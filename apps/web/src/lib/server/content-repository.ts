import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  MAX_CONTENT_BACKUP_BYTES,
  MAX_CONTENT_PLANS,
  MAX_CONTENT_VERSIONS,
  contentBackupSchema,
  contentFileSchema,
  contentPlanSchema,
  contentOutputSchema,
  contentOptionsSchema,
  currentContentVersion,
  estimateContentDuration,
  parseLibraryImport,
  type AITemplate,
  type ComparisonPlan,
  type ContentField,
  type ContentMetadata,
  type ContentOptions,
  type ContentOutput,
  type ContentPlan,
  type ContentVersion,
  type Product,
} from '@productspy/shared';
import { publishAtomicFile } from './atomic-file';
import { dataDirectory } from './product-repository';
import { AppError } from './errors';
interface Registry {
  queues: Map<string, Promise<unknown>>;
  repositories: Map<string, LocalContentRepository>;
}
const globalRegistry = globalThis as typeof globalThis & { __productspyContent?: Registry };
const registry = (globalRegistry.__productspyContent ??= {
  queues: new Map(),
  repositories: new Map(),
});
function now(previous?: string): string {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}
function validateSources(plans: ContentPlan[]): void {
  for (const plan of plans)
    for (const product of [plan.productSnapshot, ...(plan.comparisonSource?.products ?? [])])
      parseLibraryImport([{ ...product, groupIds: [], tagIds: [] }]);
}
export class LocalContentRepository {
  readonly directory: string;
  readonly filePath: string;
  constructor(directory = dataDirectory()) {
    this.directory = resolve(/* turbopackIgnore: true */ directory);
    this.filePath = join(this.directory, 'content-plans.json');
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
  private async read(): Promise<ContentPlan[]> {
    try {
      if ((await stat(this.filePath)).size > MAX_CONTENT_BACKUP_BYTES)
        throw new Error('Content file too large');
      const file = contentFileSchema.parse(
        JSON.parse(await readFile(this.filePath, 'utf8')) as unknown,
      );
      validateSources(file.plans);
      return file.plans;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return [];
      console.error('[ProductSpy content] Unable to read content file', error);
      throw new AppError(
        500,
        '内容方案文件无法读取。请保留 content-plans.json 并检查日志；原商品、模板和分析历史未改动。',
      );
    }
  }
  private async write(plans: ContentPlan[]): Promise<void> {
    const file = contentFileSchema.parse({ schemaVersion: 1, plans });
    validateSources(file.plans);
    const text = JSON.stringify(file, null, 2);
    if (Buffer.byteLength(text) > MAX_CONTENT_BACKUP_BYTES)
      throw new AppError(413, '内容方案超过 25 MiB，请先导出备份并整理；不会覆盖原内容。');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.content-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await publishAtomicFile(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  private required(plans: ContentPlan[], id: string, expectedUpdatedAt?: string): ContentPlan {
    const plan = plans.find((item) => item.id === id);
    if (!plan) throw new AppError(404, '内容方案已删除或不存在，请刷新列表。');
    if (expectedUpdatedAt !== undefined && plan.updatedAt !== expectedUpdatedAt)
      throw new AppError(409, '内容方案已被更新，请刷新后重试；人工修改和旧版本未覆盖。');
    return plan;
  }
  private capacity(plan: ContentPlan): void {
    if (plan.versions.length >= MAX_CONTENT_VERSIONS)
      throw new AppError(
        409,
        '此方案已保存 50 个内容版本，请先导出或创建新方案；不会删除历史或发起 AI 请求。',
      );
  }
  list(): Promise<ContentPlan[]> {
    return this.transaction(async () =>
      (await this.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }
  get(id: string): Promise<ContentPlan | undefined> {
    return this.transaction(async () => (await this.read()).find((plan) => plan.id === id));
  }
  create(
    name: string,
    product: Product,
    template: AITemplate,
    options?: ContentOptions,
    comparisonSource?: ComparisonPlan,
  ): Promise<ContentPlan> {
    return this.transaction(async () => {
      const plans = await this.read();
      if (plans.length >= MAX_CONTENT_PLANS)
        throw new AppError(409, '最多保存 200 个内容方案，请先备份并整理。');
      const time = now();
      const parsed = contentPlanSchema.safeParse({
        id: randomUUID(),
        name,
        productId: product.id,
        productSnapshot: product,
        templateSnapshot: template,
        ...(comparisonSource ? { comparisonSource } : {}),
        options: contentOptionsSchema.parse(options ?? {}),
        status: 'draft',
        favorite: false,
        createdAt: time,
        updatedAt: time,
        versions: [],
      });
      if (!parsed.success)
        throw new AppError(400, parsed.error.issues[0]?.message ?? '内容方案来源或参数格式无效');
      await this.write([...plans, parsed.data]);
      return parsed.data;
    });
  }
  assertCapacity(id: string, expectedUpdatedAt: string): Promise<void> {
    return this.transaction(async () =>
      this.capacity(this.required(await this.read(), id, expectedUpdatedAt)),
    );
  }
  update(
    id: string,
    input: {
      expectedUpdatedAt: string;
      name?: string;
      status?: ContentPlan['status'];
      favorite?: boolean;
      options?: ContentOptions;
      output?: ContentOutput;
      restoreVersionId?: string;
      adoptVersionId?: string;
    },
  ): Promise<ContentPlan> {
    return this.transaction(async () => {
      const plans = await this.read();
      const plan = this.required(plans, id, input.expectedUpdatedAt);
      if (
        [
          input.output !== undefined,
          input.restoreVersionId !== undefined,
          input.adoptVersionId !== undefined,
        ].filter(Boolean).length > 1
      )
        throw new AppError(400, '请分别保存编辑、恢复或采用版本。');
      if (input.name !== undefined) plan.name = input.name;
      if (input.status !== undefined) plan.status = input.status;
      if (input.favorite !== undefined) plan.favorite = input.favorite;
      if (input.options) plan.options = contentOptionsSchema.parse(input.options);
      const time = now(plan.updatedAt);
      if (input.output || input.restoreVersionId) {
        this.capacity(plan);
        const current = currentContentVersion(plan);
        const source = input.restoreVersionId
          ? plan.versions.find((version) => version.id === input.restoreVersionId)
          : current;
        if (input.restoreVersionId && !source) throw new AppError(404, '要恢复的内容版本不存在。');
        const output = contentOutputSchema.parse(input.output ?? source?.output);
        const metadata = source?.metadata
          ? {
              ...source.metadata,
              textDurationEstimate: estimateContentDuration(output, source.metadata.options),
            }
          : undefined;
        const version: ContentVersion = {
          id: randomUUID(),
          createdAt: time,
          kind: input.restoreVersionId ? 'restored' : 'edited',
          output,
          ...(metadata ? { metadata } : {}),
          ...(input.restoreVersionId ? { restoredFrom: input.restoreVersionId } : {}),
          ...(plan.currentVersionId ? { parentVersionId: plan.currentVersionId } : {}),
        };
        plan.versions.push(version);
        plan.currentVersionId = version.id;
      }
      if (input.adoptVersionId) {
        if (!plan.versions.some((version) => version.id === input.adoptVersionId))
          throw new AppError(404, '要采用的内容版本不存在。');
        plan.currentVersionId = input.adoptVersionId;
      }
      plan.updatedAt = time;
      const parsed = contentPlanSchema.safeParse(plan);
      if (!parsed.success)
        throw new AppError(400, parsed.error.issues[0]?.message ?? '内容格式无效');
      await this.write(plans);
      return parsed.data;
    });
  }
  saveGenerated(
    id: string,
    output: ContentOutput,
    expectedUpdatedAt: string,
    metadata: ContentMetadata,
    selectedFields?: ContentField[],
  ): Promise<{ plan: ContentPlan; version: ContentVersion }> {
    return this.transaction(async () => {
      const plans = await this.read();
      const plan = this.required(plans, id, expectedUpdatedAt);
      this.capacity(plan);
      const current = currentContentVersion(plan);
      const combined =
        selectedFields && current
          ? {
              ...current.output,
              ...Object.fromEntries(selectedFields.map((field) => [field, output[field]])),
            }
          : output;
      const validated = contentOutputSchema.parse(combined);
      const time = now(plan.updatedAt);
      const version: ContentVersion = {
        id: randomUUID(),
        createdAt: time,
        kind: 'generated',
        output: validated,
        metadata: {
          ...metadata,
          textDurationEstimate: estimateContentDuration(validated, metadata.options),
          ...(selectedFields ? { selectedFields } : {}),
        },
        ...(current ? { parentVersionId: current.id } : {}),
      };
      plan.versions.push(version);
      // Every later generation is a candidate. The current manual/generated result remains selected.
      if (!current) plan.currentVersionId = version.id;
      plan.options = metadata.options;
      plan.updatedAt = time;
      await this.write(plans);
      return { plan, version };
    });
  }
  delete(id: string, expectedUpdatedAt: string, confirmed: boolean): Promise<void> {
    return this.transaction(async () => {
      if (!confirmed) throw new AppError(400, '删除内容方案需要再次确认。');
      const plans = await this.read();
      this.required(plans, id, expectedUpdatedAt);
      await this.write(plans.filter((plan) => plan.id !== id));
    });
  }
  backup(): Promise<{
    format: 'productspy-content';
    schemaVersion: 1;
    exportedAt: string;
    plans: ContentPlan[];
    revision: string;
  }> {
    return this.transaction(async () => {
      const plans = await this.read();
      return {
        format: 'productspy-content',
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
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(value);
      } catch {
        throw new AppError(400, '内容备份无法编码为 JSON，尚未导入。');
      }
      if (encoded === undefined) throw new AppError(400, '请选择有效的内容 JSON 备份。');
      if (Buffer.byteLength(encoded) > MAX_CONTENT_BACKUP_BYTES)
        throw new AppError(413, '内容备份超过 25 MiB，请减少文件内容；尚未导入。');
      const parsed = contentBackupSchema.safeParse(value);
      if (!parsed.success)
        throw new AppError(
          400,
          '请选择有效的 ProductSpy 内容备份，来源、参数和完整历史都需要通过校验。',
        );
      try {
        validateSources(parsed.data.plans);
      } catch {
        throw new AppError(400, '内容备份含不安全地址或不匹配的 ASIN，尚未导入。');
      }
      const plans = await this.read();
      const revision = createHash('sha256').update(JSON.stringify(plans)).digest('hex');
      const ids = new Set(plans.map((plan) => plan.id));
      const incoming = parsed.data.plans.filter((plan) => !ids.has(plan.id));
      const conflicts = parsed.data.plans
        .filter((plan) => ids.has(plan.id))
        .map((plan) => ({ id: plan.id, name: plan.name }));
      if (input.commit) {
        if (input.expectedRevision !== revision)
          throw new AppError(409, '内容方案在预览后已更新，请重新预览备份。');
        if (plans.length + incoming.length > MAX_CONTENT_PLANS)
          throw new AppError(413, '导入后超过 200 个内容方案，请减少备份内容。');
        await this.write([...plans, ...incoming]);
      }
      return {
        total: parsed.data.plans.length,
        imported: input.commit ? incoming.length : 0,
        skipped: conflicts.length,
        conflicts,
        revision,
      };
    });
  }
}
export function getContentRepository(): LocalContentRepository {
  const directory = dataDirectory();
  let repository = registry.repositories.get(directory);
  if (!repository) {
    repository = new LocalContentRepository(directory);
    registry.repositories.set(directory, repository);
  }
  return repository;
}
