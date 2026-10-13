import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  MAX_TEMPLATES,
  cleanupHistoryVersions,
  MAX_TEMPLATE_BACKUP_BYTES,
  MAX_TEMPLATE_VERSIONS,
  aiTemplateSchema,
  builtinTemplates,
  templateBackupSchema,
  templateDefinition,
  templateDefinitionSchema,
  templateFileSchema,
  type AITemplate,
  type TemplateBackup,
  type TemplateDefinition,
} from '@productspy/shared';
import { publishAtomicFile } from './atomic-file';
import { withBusinessOperation } from './business-lock';
import { AppError } from './errors';
import { dataDirectory } from './product-repository';

interface Registry {
  queues: Map<string, Promise<unknown>>;
  repositories: Map<string, LocalTemplateRepository>;
}
const globals = globalThis as typeof globalThis & { __productspyTemplates?: Registry };
const registry = (globals.__productspyTemplates ??= { queues: new Map(), repositories: new Map() });
const nextTime = (previous?: string): string =>
  new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
const revision = (templates: AITemplate[]): string =>
  createHash('sha256').update(JSON.stringify(templates)).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);

export interface TemplateImportResult {
  revision: string;
  conflicts: { id: string; name: string }[];
  imported: number;
  skipped: number;
  committed: boolean;
}
export class LocalTemplateRepository {
  readonly directory: string;
  readonly filePath: string;
  constructor(directory = dataDirectory()) {
    this.directory = resolve(/* turbopackIgnore: true */ directory);
    this.filePath = join(this.directory, 'templates.json');
  }
  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const previous = registry.queues.get(this.filePath) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => withBusinessOperation(this.directory, operation));
    registry.queues.set(
      this.filePath,
      result.catch(() => undefined),
    );
    return result;
  }
  private async read(): Promise<AITemplate[]> {
    try {
      if ((await stat(this.filePath)).size > MAX_TEMPLATE_BACKUP_BYTES)
        throw new Error('Template file exceeds size limit');
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      return templateFileSchema.parse(value).templates;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return [];
      console.error('[ProductSpy templates] Unable to read template file', error);
      throw new AppError(
        500,
        '本地模板文件无法读取。请保留 templates.json 并检查日志；现有商品与模板未覆盖。',
      );
    }
  }
  private async write(templates: AITemplate[]): Promise<void> {
    const data = templateFileSchema.safeParse({ schemaVersion: 1, templates });
    if (!data.success) throw new AppError(400, data.error.issues[0]?.message ?? '模板数据格式无效');
    const text = JSON.stringify(data.data, null, 2);
    if (Buffer.byteLength(text) > MAX_TEMPLATE_BACKUP_BYTES)
      throw new AppError(413, '模板资料超过 25 MiB。请先导出备份并整理模板；不会覆盖原文件。');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.templates-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await publishAtomicFile(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  list(): Promise<AITemplate[]> {
    return this.transaction(async () => [
      ...(await this.read()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      ...clone(builtinTemplates),
    ]);
  }
  get(id: string): Promise<AITemplate | undefined> {
    return this.transaction(
      async () =>
        (await this.read()).find((template) => template.id === id) ??
        clone(builtinTemplates.find((template) => template.id === id)),
    );
  }
  create(input: TemplateDefinition): Promise<AITemplate> {
    return this.transaction(async () => {
      const templates = await this.read();
      if (templates.length >= MAX_TEMPLATES)
        throw new AppError(409, '最多保存 200 个用户模板。请先备份并整理现有模板。');
      const definition = templateDefinitionSchema.safeParse(input);
      if (!definition.success)
        throw new AppError(400, definition.error.issues[0]?.message ?? '模板格式无效');
      const time = nextTime();
      const template = aiTemplateSchema.parse({
        ...definition.data,
        id: randomUUID(),
        origin: 'custom',
        createdAt: time,
        updatedAt: time,
        versions: [
          { id: randomUUID(), createdAt: time, kind: 'created', snapshot: definition.data },
        ],
      });
      await this.write([...templates, template]);
      return template;
    });
  }
  private required(templates: AITemplate[], id: string, expectedUpdatedAt: string): AITemplate {
    if (builtinTemplates.some((template) => template.id === id))
      throw new AppError(403, '内置模板为只读。请先复制为用户模板，再编辑或收藏。');
    const template = templates.find((item) => item.id === id);
    if (!template) throw new AppError(404, '模板已删除或不存在，请刷新模板列表。');
    if (template.updatedAt !== expectedUpdatedAt)
      throw new AppError(409, '模板已在其他页面更新，请刷新后重试；现有版本未覆盖。');
    return template;
  }
  update(
    id: string,
    input: {
      expectedUpdatedAt: string;
      definition?: TemplateDefinition;
      favorite?: boolean;
      restoreVersionId?: string;
    },
  ): Promise<AITemplate> {
    return this.transaction(async () => {
      const templates = await this.read();
      const current = this.required(templates, id, input.expectedUpdatedAt);
      const restore = input.restoreVersionId
        ? current.versions.find((version) => version.id === input.restoreVersionId)
        : undefined;
      if (input.restoreVersionId && !restore) throw new AppError(404, '此模板历史版本不存在。');
      if ((input.definition || input.favorite !== undefined) && input.restoreVersionId)
        throw new AppError(400, '请分别保存模板编辑和恢复历史版本。');
      const definition = templateDefinitionSchema.safeParse({
        ...(restore?.snapshot ?? input.definition ?? templateDefinition(current)),
        ...(input.favorite !== undefined ? { favorite: input.favorite } : {}),
      });
      if (!definition.success)
        throw new AppError(400, definition.error.issues[0]?.message ?? '模板格式无效');
      if (
        !restore &&
        JSON.stringify(definition.data) === JSON.stringify(templateDefinition(current))
      )
        return current;
      if (current.versions.length >= MAX_TEMPLATE_VERSIONS)
        throw new AppError(
          409,
          '此模板已有 50 个历史版本。请在历史容量管理中先归档，再确认清理旧版本；不会自动删除已有编辑。',
        );
      const time = nextTime(current.updatedAt);
      const updated = aiTemplateSchema.parse({
        ...current,
        ...definition.data,
        updatedAt: time,
        versions: [
          ...current.versions,
          {
            id: randomUUID(),
            createdAt: time,
            kind: restore ? 'restored' : 'edited',
            snapshot: definition.data,
            ...(restore ? { restoredFrom: restore.id } : {}),
          },
        ],
      });
      templates[templates.findIndex((template) => template.id === id)] = updated;
      await this.write(templates);
      return updated;
    });
  }
  delete(id: string, expectedUpdatedAt: string, confirmed: boolean): Promise<void> {
    return this.transaction(async () => {
      if (!confirmed) throw new AppError(400, '删除模板需要再次确认。');
      const templates = await this.read();
      this.required(templates, id, expectedUpdatedAt);
      await this.write(templates.filter((template) => template.id !== id));
    });
  }
  cleanupHistory(
    id: string,
    expectedUpdatedAt: string,
    versionIds: string[],
    archiveSha256: string,
    expectedRevision: string,
  ): Promise<AITemplate> {
    return this.transaction(async () => {
      const templates = await this.read();
      const template = this.required(templates, id, expectedUpdatedAt);
      if (createHash('sha256').update(JSON.stringify(template)).digest('hex') !== expectedRevision)
        throw new AppError(409, '模板归档内容已变化，请重新导出；没有清理任何版本。');
      try {
        template.versions = cleanupHistoryVersions(
          template.versions,
          template.versions.at(-1)?.id,
          versionIds,
          archiveSha256,
        );
      } catch (error) {
        throw new AppError(400, error instanceof Error ? error.message : '历史清理无效');
      }
      template.updatedAt = nextTime(template.updatedAt);
      await this.write(templates);
      return template;
    });
  }
  backup(): Promise<TemplateBackup> {
    return this.transaction(async () => ({
      format: 'productspy-templates',
      schemaVersion: 1,
      exportedAt: nextTime(),
      templates: await this.read(),
    }));
  }
  importBackup(
    backup: unknown,
    options: {
      commit?: boolean;
      expectedRevision?: string;
      policy?: 'skip';
    } = {},
  ): Promise<TemplateImportResult> {
    return this.transaction(async () => {
      const serialized = JSON.stringify(backup);
      if (!serialized || Buffer.byteLength(serialized) > MAX_TEMPLATE_BACKUP_BYTES)
        throw new AppError(413, '模板备份为空或超过 25 MiB，请重新选择文件。');
      const parsed = templateBackupSchema.safeParse(backup);
      if (!parsed.success)
        throw new AppError(400, parsed.error.issues[0]?.message ?? '模板备份格式无效');
      const current = await this.read();
      const currentRevision = revision(current);
      const ids = new Set(current.map((template) => template.id));
      const conflicts = parsed.data.templates
        .filter((template) => ids.has(template.id))
        .map(({ id, name }) => ({ id, name }));
      const accepted = parsed.data.templates.filter((template) => !ids.has(template.id));
      const result = {
        revision: currentRevision,
        conflicts,
        imported: accepted.length,
        skipped: conflicts.length,
        committed: Boolean(options.commit),
      };
      if (!options.commit) return result;
      if (!options.expectedRevision || options.expectedRevision !== currentRevision)
        throw new AppError(409, '模板库已变化或尚未预览，请重新预览导入；现有模板没有覆盖。');
      if (conflicts.length > 0 && options.policy !== 'skip')
        throw new AppError(409, '导入包含已有模板，请明确选择跳过冲突；已有编辑与历史不会覆盖。');
      if (current.length + accepted.length > MAX_TEMPLATES)
        throw new AppError(409, '导入后超过 200 个用户模板，请减少导入数量；没有写入任何资料。');
      if (accepted.length) await this.write([...current, ...accepted]);
      return result;
    });
  }
}
export function getTemplateRepository(): LocalTemplateRepository {
  const directory = resolve(/* turbopackIgnore: true */ dataDirectory());
  const existing = registry.repositories.get(directory);
  if (existing) return existing;
  const repository = new LocalTemplateRepository(directory);
  registry.repositories.set(directory, repository);
  return repository;
}
