import {
  analysisSchema,
  draftSchema,
  mergeProduct,
  productKey,
  productSchema,
} from '@productspy/shared';
import type {
  Product,
  ProductAnalysis,
  ProductDraft,
  ProductStorageAdapter,
} from '@productspy/shared';

const STORAGE_KEY = 'productspy.local.v1';
interface LocalState {
  products: Record<string, Product>;
  pending: Record<string, ProductDraft>;
}

export class ExtensionLocalStorageAdapter implements ProductStorageAdapter {
  private queue: Promise<unknown> = Promise.resolve();

  private async read(): Promise<LocalState> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const value: unknown = result[STORAGE_KEY];
    if (!value || typeof value !== 'object' || !('products' in value) || !('pending' in value)) {
      return { products: {}, pending: {} };
    }
    const record = value as { products: Record<string, unknown>; pending: Record<string, unknown> };
    const products: Record<string, Product> = {};
    const pending: Record<string, ProductDraft> = {};
    for (const item of Object.values(record.products ?? {})) {
      const parsed = productSchema.safeParse(item);
      if (parsed.success) products[parsed.data.id] = parsed.data;
    }
    for (const item of Object.values(record.pending ?? {})) {
      const parsed = draftSchema.safeParse(item);
      if (parsed.success) pending[productKey(parsed.data)] = parsed.data;
    }
    return { products, pending };
  }

  private transaction<T>(mutate: (state: LocalState) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      const result = mutate(state);
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async list(): Promise<Product[]> {
    await this.queue;
    return Object.values((await this.read()).products).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async get(id: string): Promise<Product | undefined> {
    await this.queue;
    return (await this.read()).products[id];
  }

  async upsert(draft: ProductDraft): Promise<Product> {
    const validated = draftSchema.parse(draft);
    return this.transaction((state) => {
      const existing = Object.values(state.products).find(
        (item) => productKey(item) === productKey(validated),
      );
      const product = mergeProduct(validated, existing);
      state.products[product.id] = product;
      return product;
    });
  }

  async enqueue(draft: ProductDraft): Promise<Product> {
    const validated = draftSchema.parse(draft);
    return this.transaction((state) => {
      const existing = Object.values(state.products).find(
        (item) => productKey(item) === productKey(validated),
      );
      const product = mergeProduct(validated, existing);
      state.products[product.id] = product;
      state.pending[productKey(validated)] = validated;
      return product;
    });
  }

  async remember(product: Product): Promise<void> {
    const validated = productSchema.parse(product);
    await this.transaction((state) => {
      for (const [id, item] of Object.entries(state.products)) {
        if (productKey(item) === productKey(validated)) delete state.products[id];
      }
      state.products[validated.id] = validated;
      delete state.pending[productKey(validated)];
    });
  }

  async pendingDrafts(): Promise<ProductDraft[]> {
    await this.queue;
    return Object.values((await this.read()).pending);
  }

  async delete(id: string): Promise<void> {
    await this.transaction((state) => {
      const product = state.products[id];
      if (product) delete state.pending[productKey(product)];
      delete state.products[id];
    });
  }

  async saveAnalysis(
    id: string,
    analysis: ProductAnalysis,
    expectedUpdatedAt?: string,
  ): Promise<Product> {
    const validated = analysisSchema.parse(analysis);
    return this.transaction((state) => {
      const product = state.products[id];
      if (!product) throw new Error('本地商品不存在，请重新采集。');
      if (expectedUpdatedAt && product.updatedAt !== expectedUpdatedAt) {
        throw new Error('分析期间商品已更新，请重新采集后再分析。');
      }
      const updated = {
        ...product,
        aiAnalysis: validated,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(product.updatedAt) + 1)).toISOString(),
      };
      state.products[id] = updated;
      return updated;
    });
  }
}
