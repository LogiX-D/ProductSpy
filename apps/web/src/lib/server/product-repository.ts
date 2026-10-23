import { publishAtomicFile } from './atomic-file';
import { withBusinessOperation } from './business-lock';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  MAX_ANALYSIS_VERSIONS,
  cleanupHistoryVersions,
  MAX_LIBRARY_GROUPS,
  MAX_LIBRARY_TAGS,
  MAX_MEMBERSHIPS,
  analysisMetadataSchema,
  analysisSchema,
  draftSchema,
  mergeProduct,
  productKey,
  productSchema,
  libraryFileSchema,
  libraryDefinitionRequestSchema,
  libraryBatchRequestSchema,
  validateLibraryRelations,
  mergeLibraryImport,
  parseLibraryImport,
  type AnalysisSaveContext,
  type AnalysisVersion,
  type Product,
  type ProductAnalysis,
  type ProductDraft,
  type ProductRepository,
  type LibrarySnapshot,
  type LibraryDefinitionRequest,
  type LibraryBatchRequest,
  type LibraryBatchResult,
  type LibraryImportResult,
} from '@productspy/shared';
import { AppError } from './errors';
import { saasEnabled, tenantDirectory } from '../saas/context';
import { readWorkspaceDocument, writeWorkspaceDocument } from '../saas/workspace-storage';

interface TransactionQueue {
  tail: Promise<unknown>;
}
interface RepositoryRegistry {
  queues: Map<string, TransactionQueue>;
  repositories: Map<string, LocalJsonProductRepository>;
}
const globalRegistry = globalThis as typeof globalThis & {
  __productspyRepositories?: RepositoryRegistry;
};
const registry = (globalRegistry.__productspyRepositories ??= {
  queues: new Map(),
  repositories: new Map(),
});

export function dataDirectory(): string {
  if (saasEnabled()) return tenantDirectory();
  return resolve(
    /* turbopackIgnore: true */ process.env.PRODUCTSPY_DATA_DIR ?? join(process.cwd(), '.data'),
  );
}

function nextUpdatedAt(previous?: string): string {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}

export { MAX_ANALYSIS_VERSIONS } from '@productspy/shared';

/** Backfill the active v0.3 result lazily, without rewriting old data on read. */
function archiveCurrent(product: Product): AnalysisVersion[] {
  const history = [...(product.analysisHistory ?? [])];
  if (!product.aiAnalysis) return history;
  const last = history.at(-1);
  if (
    last &&
    JSON.stringify(last.analysis) === JSON.stringify(product.aiAnalysis) &&
    JSON.stringify(last.metadata) === JSON.stringify(product.analysisMetadata)
  )
    return history;
  if (history.length >= MAX_ANALYSIS_VERSIONS)
    throw new AppError(
      409,
      '此商品已保存 50 个分析版本。请在历史容量管理中先归档，再确认清理旧版本；本次操作没有删除或覆盖已有版本。',
    );
  history.push({
    id: randomUUID(),
    createdAt: product.updatedAt,
    kind: 'legacy',
    analysis: product.aiAnalysis,
    ...(product.analysisMetadata ? { metadata: product.analysisMetadata } : {}),
  });
  return history;
}

function assertCapacity(product: Product): void {
  if (archiveCurrent(product).length >= MAX_ANALYSIS_VERSIONS)
    throw new AppError(
      409,
      '此商品已保存 50 个分析版本。请在历史容量管理中先归档，再确认清理旧版本；不会自动删除历史，也不会发起新的 AI 请求。',
    );
}

function withSavedAnalysis(
  existing: Product,
  analysis: ProductAnalysis,
  context: AnalysisSaveContext = {},
): Product {
  assertCapacity(existing);
  const history = archiveCurrent(existing);
  const updatedAt = nextUpdatedAt(existing.updatedAt);
  const metadata = context.metadata ?? existing.analysisMetadata;
  const version: AnalysisVersion = {
    id: randomUUID(),
    createdAt: updatedAt,
    kind: context.kind ?? 'edited',
    analysis,
    ...(metadata ? { metadata } : {}),
    ...(history.at(-1) ? { parentVersionId: history.at(-1)?.id } : {}),
    ...(context.restoredFrom ? { restoredFrom: context.restoredFrom } : {}),
  };
  return {
    ...existing,
    aiAnalysis: analysis,
    ...(metadata ? { analysisMetadata: metadata } : {}),
    analysisHistory: [...history, version],
    updatedAt,
  };
}

export class LocalJsonProductRepository implements ProductRepository {
  readonly filePath: string;
  private readonly queue: TransactionQueue;

  constructor(readonly directory = dataDirectory()) {
    this.directory = resolve(/* turbopackIgnore: true */ directory);
    this.filePath = join(this.directory, 'products.json');
    let queue = registry.queues.get(this.filePath);
    if (!queue) {
      queue = { tail: Promise.resolve() };
      registry.queues.set(this.filePath, queue);
    }
    this.queue = queue;
  }

  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.tail
      .catch(() => undefined)
      .then(() => withBusinessOperation(this.directory, operation));
    this.queue.tail = result.catch(() => undefined);
    return result;
  }

  private async readLibrary(): Promise<LibrarySnapshot> {
    let source: string;
    try {
      source = saasEnabled()
        ? await readWorkspaceDocument(this.directory, 'products.json')
        : await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return {
          products: [],
          groups: [],
          tags: [],
          revision: createHash('sha256').update('empty-library').digest('hex'),
        };
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(source) as unknown;
    } catch {
      throw new AppError(500, '本地素材库文件损坏，请保留 products.json 并检查服务日志');
    }
    const parsed = Array.isArray(raw)
      ? productSchema.array().safeParse(raw)
      : libraryFileSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('[ProductSpy storage] Invalid database schema', parsed.error.issues);
      throw new AppError(500, '本地素材库格式异常，请保留 products.json 并检查服务日志');
    }
    const library: LibrarySnapshot = Array.isArray(parsed.data)
      ? { products: parsed.data, groups: [], tags: [] }
      : { products: parsed.data.products, groups: parsed.data.groups, tags: parsed.data.tags };
    try {
      validateLibraryRelations(library);
    } catch (error) {
      console.error('[ProductSpy storage] Invalid library relations', error);
      throw new AppError(
        500,
        '本地素材库存在重复记录或无效分组，请保留 products.json 并检查服务日志',
      );
    }
    return { ...library, revision: createHash('sha256').update(source).digest('hex') };
  }

  private async writeLibrary(library: LibrarySnapshot): Promise<void> {
    const stored = libraryFileSchema.parse({
      schemaVersion: 2,
      products: library.products,
      groups: library.groups,
      tags: library.tags,
    });
    validateLibraryRelations(stored);
    if (saasEnabled()) {
      await writeWorkspaceDocument(this.directory, 'products.json', JSON.stringify(stored));
      return;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryFile = join(this.directory, `.products-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryFile, JSON.stringify(stored, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await publishAtomicFile(temporaryFile, this.filePath);
    } finally {
      await unlink(temporaryFile).catch((error: unknown) => {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          console.error('[ProductSpy storage] Unable to clean temporary file', error);
        }
      });
    }
  }

  list(): Promise<Product[]> {
    return this.transaction(async () =>
      (await this.readLibrary()).products.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }

  get(id: string): Promise<Product | undefined> {
    return this.transaction(async () =>
      (await this.readLibrary()).products.find((product) => product.id === id),
    );
  }

  librarySnapshot(): Promise<LibrarySnapshot> {
    return this.transaction(() => this.readLibrary());
  }

  importLibrary(
    snapshot: LibrarySnapshot,
    policy: 'skip' | 'preserve',
    expectedRevision?: string,
  ): Promise<LibraryImportResult> {
    return this.transaction(async () => {
      if (policy !== 'skip' && policy !== 'preserve')
        throw new AppError(400, '请选择跳过重复商品或保留原有资料');
      let incoming: LibrarySnapshot;
      try {
        incoming = parseLibraryImport({
          format: 'productspy-library',
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          products: snapshot.products,
          groups: snapshot.groups,
          tags: snapshot.tags,
        });
      } catch (error) {
        throw new AppError(400, error instanceof Error ? error.message : '导入数据格式无效');
      }
      const existing = await this.readLibrary();
      if (expectedRevision && expectedRevision !== existing.revision)
        throw new AppError(409, '预览后商品库已发生变化，请重新预览再导入；已有资料没有被覆盖');
      let merged: ReturnType<typeof mergeLibraryImport>;
      try {
        merged = mergeLibraryImport(incoming, existing, policy, randomUUID);
      } catch (error) {
        throw new AppError(400, error instanceof Error ? error.message : '导入资料无法安全合并');
      }
      if (
        merged.result.imported > 0 ||
        merged.result.groupsAdded > 0 ||
        merged.result.tagsAdded > 0
      )
        await this.writeLibrary(merged.snapshot);
      return merged.result;
    });
  }

  manageDefinition(request: LibraryDefinitionRequest): Promise<LibrarySnapshot> {
    return this.transaction(async () => {
      const parsed = libraryDefinitionRequestSchema.safeParse(request);
      if (!parsed.success)
        throw new AppError(400, parsed.error.issues[0]?.message ?? '分组或标签操作格式无效');
      const command = parsed.data;
      const library = await this.readLibrary();
      const definitions = command.kind === 'group' ? library.groups : library.tags;
      const property = command.kind === 'group' ? 'groupIds' : 'tagIds';
      const label = command.kind === 'group' ? '分组' : '标签';
      const index = definitions.findIndex((item) => item.id === command.id);
      const existing = definitions[index];
      if (command.action !== 'create' && !existing)
        throw new AppError(404, `${label}已删除或不存在，请刷新商品库`);
      if (
        command.name &&
        definitions.some(
          (item) =>
            item.id !== command.id &&
            item.name.toLocaleLowerCase() === command.name?.toLocaleLowerCase(),
        )
      )
        throw new AppError(409, `${label}名称已存在，请使用其他名称`);
      if (command.action === 'create') {
        const maximum = command.kind === 'group' ? MAX_LIBRARY_GROUPS : MAX_LIBRARY_TAGS;
        if (definitions.length >= maximum)
          throw new AppError(409, `${label}数量已达到 ${maximum} 个上限`);
        const now = nextUpdatedAt();
        definitions.push({
          id: randomUUID(),
          name: command.name!,
          color: command.color ?? '#64748B',
          createdAt: now,
          updatedAt: now,
        });
      } else if (command.action === 'rename' && existing) {
        definitions[index] = {
          ...existing,
          ...(command.name ? { name: command.name } : {}),
          ...(command.color ? { color: command.color } : {}),
          updatedAt: nextUpdatedAt(existing.updatedAt),
        };
      } else if (command.action === 'delete' && existing) {
        definitions.splice(index, 1);
        library.products = library.products.map((product) =>
          product[property]?.includes(existing.id)
            ? {
                ...product,
                [property]: product[property]?.filter((id) => id !== existing.id),
                updatedAt: nextUpdatedAt(product.updatedAt),
              }
            : product,
        );
      }
      await this.writeLibrary(library);
      return this.readLibrary();
    });
  }

  batch(request: LibraryBatchRequest): Promise<LibraryBatchResult> {
    return this.transaction(async () => {
      const parsed = libraryBatchRequestSchema.safeParse(request);
      if (!parsed.success)
        throw new AppError(400, parsed.error.issues[0]?.message ?? '批量操作格式无效');
      const command = parsed.data;
      const library = await this.readLibrary();
      const lookup = new Map(library.products.map((product, index) => [product.id, index]));
      const result: LibraryBatchResult = { succeededIds: [], failures: [], products: [] };
      const deleted = new Set<string>();
      const property = command.operation.includes('tags') ? 'tagIds' : 'groupIds';
      const selections = property === 'tagIds' ? (command.tagIds ?? []) : (command.groupIds ?? []);
      const definitions = property === 'tagIds' ? library.tags : library.groups;
      const unknownDefinition = selections.some(
        (id) => !definitions.some((item) => item.id === id),
      );
      for (const id of command.ids) {
        const index = lookup.get(id);
        const product = index === undefined ? undefined : library.products[index];
        if (!product) {
          result.failures.push({ id, error: '商品已删除或不存在' });
          continue;
        }
        if (
          command.expectedUpdatedAt &&
          (!Object.hasOwn(command.expectedUpdatedAt, id) ||
            command.expectedUpdatedAt[id] !== product.updatedAt)
        ) {
          result.failures.push({ id, error: '商品已在其他页面更新，请刷新后再操作' });
          continue;
        }
        if (unknownDefinition && command.operation !== 'delete') {
          result.failures.push({ id, error: '所选分组或标签已删除，请刷新后重新选择' });
          continue;
        }
        if (command.operation === 'delete') {
          deleted.add(id);
        } else {
          const current = product[property] ?? [];
          const memberships =
            command.operation === 'move-group'
              ? [...new Set(selections)]
              : command.operation.startsWith('remove-')
                ? current.filter((value) => !selections.includes(value))
                : [...new Set([...current, ...selections])];
          if (memberships.length > MAX_MEMBERSHIPS) {
            result.failures.push({ id, error: `每个商品最多加入 ${MAX_MEMBERSHIPS} 个分组或标签` });
            continue;
          }
          const updated: Product = {
            ...product,
            [property]: memberships,
            updatedAt: nextUpdatedAt(product.updatedAt),
          };
          library.products[index!] = updated;
          result.products?.push(updated);
        }
        result.succeededIds.push(id);
      }
      if (result.succeededIds.length) {
        library.products = library.products.filter((product) => !deleted.has(product.id));
        // A rejected atomic write rejects the entire request; no uncommitted success is reported.
        await this.writeLibrary(library);
      }
      return result;
    });
  }

  upsert(draft: ProductDraft): Promise<Product> {
    return this.transaction(async () => {
      const parsed = draftSchema.safeParse({
        ...draft,
        sourceId: draft.sourceId.trim().toUpperCase(),
      });
      if (!parsed.success)
        throw new AppError(400, '商品信息不完整或格式无效，请重新采集 Amazon 商品页面');
      const library = await this.readLibrary();
      const products = library.products;
      const existingIndex = products.findIndex(
        (product) => productKey(product) === productKey(parsed.data),
      );
      const existing = products[existingIndex];
      const product = mergeProduct(parsed.data, existing, nextUpdatedAt(existing?.updatedAt));
      if (existing?.aiAnalysis && !product.aiAnalysis) {
        product.analysisHistory = archiveCurrent(existing);
        delete product.analysisMetadata;
      }
      if (existingIndex === -1) products.push(product);
      else products[existingIndex] = product;
      await this.writeLibrary(library);
      return product;
    });
  }

  delete(id: string): Promise<void> {
    return this.transaction(async () => {
      const library = await this.readLibrary();
      const products = library.products;
      const remaining = products.filter((product) => product.id !== id);
      if (remaining.length === products.length) throw new AppError(404, '商品已删除或不存在');
      await this.writeLibrary({ ...library, products: remaining });
    });
  }

  saveAnalysis(
    id: string,
    analysis: ProductAnalysis,
    expectedUpdatedAt?: string,
    context?: AnalysisSaveContext,
  ): Promise<Product> {
    return this.transaction(async () => {
      const parsed = analysisSchema.safeParse(analysis);
      if (!parsed.success) throw new AppError(502, 'AI 返回内容不完整，请重新分析');
      if (context?.metadata && !analysisMetadataSchema.safeParse(context.metadata).success)
        throw new AppError(502, '分析来源或用量信息格式无效，请检查 AI 配置；已有结果没有被覆盖');
      const library = await this.readLibrary();
      const products = library.products;
      const index = products.findIndex((product) => product.id === id);
      const existing = products[index];
      if (!existing) throw new AppError(404, '商品已删除或不存在');
      if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) {
        throw new AppError(409, '分析期间商品已更新，请刷新商品后重新分析');
      }
      const product = withSavedAnalysis(existing, parsed.data, context);
      products[index] = product;
      await this.writeLibrary(library);
      return product;
    });
  }

  assertAnalysisCapacity(id: string, expectedUpdatedAt: string): Promise<void> {
    return this.transaction(async () => {
      const existing = (await this.readLibrary()).products.find((product) => product.id === id);
      if (!existing) throw new AppError(404, '商品已删除或不存在');
      if (existing.updatedAt !== expectedUpdatedAt)
        throw new AppError(409, '商品资料已更新，请刷新商品后重新分析');
      assertCapacity(existing);
    });
  }

  analysisHistory(id: string): Promise<AnalysisVersion[]> {
    return this.transaction(async () => {
      const existing = (await this.readLibrary()).products.find((product) => product.id === id);
      if (!existing) throw new AppError(404, '商品已删除或不存在');
      return existing.analysisHistory ?? [];
    });
  }

  restoreAnalysis(id: string, versionId: string, expectedUpdatedAt: string): Promise<Product> {
    return this.transaction(async () => {
      const library = await this.readLibrary();
      const products = library.products;
      const index = products.findIndex((product) => product.id === id);
      const existing = products[index];
      if (!existing) throw new AppError(404, '商品已删除或不存在');
      if (existing.updatedAt !== expectedUpdatedAt)
        throw new AppError(409, '商品或分析已在其他页面更新，请刷新后再恢复历史');
      const version = existing.analysisHistory?.find((item) => item.id === versionId);
      if (!version) throw new AppError(404, '指定的分析版本不存在');
      const product = withSavedAnalysis(existing, version.analysis, {
        kind: 'restored',
        metadata: version.metadata,
        restoredFrom: version.id,
      });
      // Restoring a legacy version must not inherit provenance from the newer active result.
      if (!version.metadata) {
        delete product.analysisMetadata;
        const restored = product.analysisHistory?.at(-1);
        if (restored) delete restored.metadata;
      }
      products[index] = product;
      await this.writeLibrary(library);
      return product;
    });
  }

  cleanupHistory(
    id: string,
    expectedUpdatedAt: string,
    versionIds: string[],
    archiveSha256: string,
    expectedRevision: string,
  ): Promise<Product> {
    return this.transaction(async () => {
      const library = await this.readLibrary();
      const index = library.products.findIndex((product) => product.id === id);
      const product = library.products[index];
      if (!product) throw new AppError(404, '商品已删除或不存在');
      if (product.updatedAt !== expectedUpdatedAt)
        throw new AppError(409, '商品或分析已变化，请重新导出归档；没有清理任何版本。');
      if (createHash('sha256').update(JSON.stringify(product)).digest('hex') !== expectedRevision)
        throw new AppError(409, '商品归档内容已变化，请重新导出；没有清理任何版本。');
      const history = product.analysisHistory ?? [];
      const current = [...history]
        .reverse()
        .find(
          (version) =>
            JSON.stringify(version.analysis) === JSON.stringify(product.aiAnalysis) &&
            JSON.stringify(version.metadata) === JSON.stringify(product.analysisMetadata),
        );
      try {
        product.analysisHistory = cleanupHistoryVersions(
          history,
          current?.id,
          versionIds,
          archiveSha256,
        );
      } catch (error) {
        throw new AppError(400, error instanceof Error ? error.message : '历史清理无效');
      }
      product.updatedAt = nextUpdatedAt(product.updatedAt);
      library.products[index] = product;
      await this.writeLibrary(library);
      return product;
    });
  }
}

export function getProductRepository(): LocalJsonProductRepository {
  const directory = dataDirectory();
  let repository = registry.repositories.get(directory);
  if (!repository) {
    repository = new LocalJsonProductRepository(directory);
    registry.repositories.set(directory, repository);
  }
  return repository;
}
