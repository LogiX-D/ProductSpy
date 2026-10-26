import Dexie, { type Table } from 'dexie';
import { isLegacyMode } from '../session';
import {
  mergeProduct,
  productKey,
  type Product,
  type ProductAnalysis,
  type ProductDraft,
  type ProductStorageAdapter,
} from '@productspy/shared';

class ProductCache extends Dexie {
  products!: Table<Product, string>;
  constructor() {
    super('productspy-workspace');
    this.version(1).stores({ products: 'id, [source+sourceId], updatedAt' });
  }
}
let cache: ProductCache | undefined;
function db(): ProductCache {
  cache ??= new ProductCache();
  return cache;
}

/** Browser-local IndexedDB adapter. The localhost repository is the canonical source. */
export class WebLocalStorageAdapter implements ProductStorageAdapter {
  constructor(private readonly enabled = true) {}
  async list(): Promise<Product[]> {
    if (!this.enabled) return [];
    return db().products.orderBy('updatedAt').reverse().toArray();
  }
  async get(id: string): Promise<Product | undefined> {
    if (!this.enabled) return undefined;
    return db().products.get(id);
  }
  async upsert(draft: ProductDraft): Promise<Product> {
    if (!this.enabled) return mergeProduct(draft);
    return db().transaction('rw', db().products, async () => {
      const existing = await db().products.get(productKey(draft));
      const product = mergeProduct(draft, existing);
      await db().products.put(product);
      return product;
    });
  }
  async delete(id: string): Promise<void> {
    if (!this.enabled) return;
    await db().products.delete(id);
  }
  async saveAnalysis(
    id: string,
    analysis: ProductAnalysis,
    expectedUpdatedAt?: string,
  ): Promise<Product> {
    if (!this.enabled) throw new Error('在线工作台仅通过账号 API 保存分析。');
    return db().transaction('rw', db().products, async () => {
      const existing = await this.get(id);
      if (!existing) throw new Error('商品不存在');
      if (expectedUpdatedAt && expectedUpdatedAt !== existing.updatedAt)
        throw new Error('商品已更新，请重新分析');
      const product: Product = {
        ...existing,
        aiAnalysis: analysis,
        updatedAt: new Date().toISOString(),
      };
      await db().products.put(product);
      return product;
    });
  }
  async replace(products: Product[]): Promise<void> {
    if (!this.enabled) return;
    await db().transaction('rw', db().products, async () => {
      await db().products.clear();
      await db().products.bulkPut(products);
    });
  }
  async put(product: Product): Promise<void> {
    if (!this.enabled) return;
    await db().products.put(product);
  }
}
// SaaS intentionally stores no business records in a shared-origin persistent cache.
export const webCache = new WebLocalStorageAdapter(isLegacyMode);
