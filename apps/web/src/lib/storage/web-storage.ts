import Dexie, { type Table } from 'dexie';
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
  async list(): Promise<Product[]> {
    return db().products.orderBy('updatedAt').reverse().toArray();
  }
  async get(id: string): Promise<Product | undefined> {
    return db().products.get(id);
  }
  async upsert(draft: ProductDraft): Promise<Product> {
    return db().transaction('rw', db().products, async () => {
      const existing = await db().products.get(productKey(draft));
      const product = mergeProduct(draft, existing);
      await db().products.put(product);
      return product;
    });
  }
  async delete(id: string): Promise<void> {
    await db().products.delete(id);
  }
  async saveAnalysis(
    id: string,
    analysis: ProductAnalysis,
    expectedUpdatedAt?: string,
  ): Promise<Product> {
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
    await db().transaction('rw', db().products, async () => {
      await db().products.clear();
      await db().products.bulkPut(products);
    });
  }
  async put(product: Product): Promise<void> {
    await db().products.put(product);
  }
}
export const webCache = new WebLocalStorageAdapter();
