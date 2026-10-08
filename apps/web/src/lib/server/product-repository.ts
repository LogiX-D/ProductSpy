import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  analysisSchema,
  draftSchema,
  mergeProduct,
  productKey,
  productSchema,
  type Product,
  type ProductAnalysis,
  type ProductDraft,
  type ProductRepository,
} from '@productspy/shared';
import { AppError } from './errors';

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
  return resolve(
    /* turbopackIgnore: true */ process.env.PRODUCTSPY_DATA_DIR ?? join(process.cwd(), '.data'),
  );
}

function nextUpdatedAt(previous?: string): string {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
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
    const result = this.queue.tail.catch(() => undefined).then(operation);
    this.queue.tail = result.catch(() => undefined);
    return result;
  }

  private async readProducts(): Promise<Product[]> {
    let source: string;
    try {
      source = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return [];
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(source) as unknown;
    } catch {
      throw new AppError(500, '本地素材库文件损坏，请保留 products.json 并检查服务日志');
    }
    const parsed = productSchema.array().safeParse(raw);
    if (!parsed.success) {
      console.error('[ProductSpy storage] Invalid database schema', parsed.error.issues);
      throw new AppError(500, '本地素材库格式异常，请保留 products.json 并检查服务日志');
    }
    const keys = parsed.data.map(productKey);
    const ids = parsed.data.map((product) => product.id);
    if (new Set(keys).size !== keys.length || new Set(ids).size !== ids.length) {
      throw new AppError(500, '本地素材库存在重复记录，请保留 products.json 并检查服务日志');
    }
    return parsed.data;
  }

  private async writeProducts(products: Product[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryFile = join(this.directory, `.products-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryFile, JSON.stringify(products, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryFile, this.filePath);
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
      (await this.readProducts()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }

  get(id: string): Promise<Product | undefined> {
    return this.transaction(async () =>
      (await this.readProducts()).find((product) => product.id === id),
    );
  }

  upsert(draft: ProductDraft): Promise<Product> {
    return this.transaction(async () => {
      const parsed = draftSchema.safeParse({
        ...draft,
        sourceId: draft.sourceId.trim().toUpperCase(),
      });
      if (!parsed.success)
        throw new AppError(400, '商品信息不完整或格式无效，请重新采集 Amazon 商品页面');
      const products = await this.readProducts();
      const existingIndex = products.findIndex(
        (product) => productKey(product) === productKey(parsed.data),
      );
      const existing = products[existingIndex];
      const product = mergeProduct(parsed.data, existing, nextUpdatedAt(existing?.updatedAt));
      if (existingIndex === -1) products.push(product);
      else products[existingIndex] = product;
      await this.writeProducts(products);
      return product;
    });
  }

  delete(id: string): Promise<void> {
    return this.transaction(async () => {
      const products = await this.readProducts();
      const remaining = products.filter((product) => product.id !== id);
      if (remaining.length === products.length) throw new AppError(404, '商品已删除或不存在');
      await this.writeProducts(remaining);
    });
  }

  saveAnalysis(
    id: string,
    analysis: ProductAnalysis,
    expectedUpdatedAt?: string,
  ): Promise<Product> {
    return this.transaction(async () => {
      const parsed = analysisSchema.safeParse(analysis);
      if (!parsed.success) throw new AppError(502, 'AI 返回内容不完整，请重新分析');
      const products = await this.readProducts();
      const index = products.findIndex((product) => product.id === id);
      const existing = products[index];
      if (!existing) throw new AppError(404, '商品已删除或不存在');
      if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) {
        throw new AppError(409, '分析期间商品已更新，请刷新商品后重新分析');
      }
      const product: Product = {
        ...existing,
        aiAnalysis: parsed.data,
        updatedAt: nextUpdatedAt(existing.updatedAt),
      };
      products[index] = product;
      await this.writeProducts(products);
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
