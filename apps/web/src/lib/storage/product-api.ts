import {
  apiRequest,
  errorMessage,
  productSchema,
  type Product,
  type ProductAnalysis,
  type ProductDraft,
  type ProductRepository,
  type ProductSyncAdapter,
} from '@productspy/shared';
import { webCache } from './web-storage';

async function cacheSafely(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn('[ProductSpy] IndexedDB cache unavailable', error);
  }
}

export class ProductApiRepository implements ProductRepository, ProductSyncAdapter {
  async list(): Promise<Product[]> {
    const data = await apiRequest<unknown>('/api/products');
    const products = productSchema.array().parse(data);
    await cacheSafely(() => webCache.replace(products));
    return products;
  }
  async get(id: string): Promise<Product | undefined> {
    const data = await apiRequest<unknown>(`/api/products/${encodeURIComponent(id)}`);
    const product = productSchema.parse(data);
    await cacheSafely(() => webCache.put(product));
    return product;
  }
  async upsert(draft: ProductDraft): Promise<Product> {
    const data = await apiRequest<unknown>('/api/products', {
      method: 'POST',
      body: JSON.stringify(draft),
    });
    const product = productSchema.parse(data);
    await cacheSafely(() => webCache.put(product));
    return product;
  }
  async save(draft: ProductDraft): Promise<Product> {
    return this.upsert(draft);
  }
  async delete(id: string): Promise<void> {
    await apiRequest<null>(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await cacheSafely(() => webCache.delete(id));
  }
  async saveAnalysis(
    id: string,
    analysis: ProductAnalysis,
    expectedUpdatedAt?: string,
  ): Promise<Product> {
    const data = await apiRequest<unknown>(`/api/products/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ analysis, expectedUpdatedAt }),
    });
    const product = productSchema.parse(data);
    await cacheSafely(() => webCache.put(product));
    return product;
  }
}
export const productRepository = new ProductApiRepository();
export async function loadProducts(): Promise<{ products: Product[]; error?: string }> {
  try {
    return { products: await productRepository.list() };
  } catch (error) {
    console.error('[ProductSpy] Failed to load products', error);
    try {
      return {
        products: await webCache.list(),
        error: `${errorMessage(error)}。当前显示本机缓存。`,
      };
    } catch {
      return { products: [], error: errorMessage(error) };
    }
  }
}
