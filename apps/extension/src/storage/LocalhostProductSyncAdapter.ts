import { apiRequest, draftSchema, productSchema } from '@productspy/shared';
import type { Product, ProductDraft, ProductSyncAdapter } from '@productspy/shared';
import { WORKSPACE_URL } from '../background/messages';

export class LocalhostProductSyncAdapter implements ProductSyncAdapter {
  async save(draft: ProductDraft): Promise<Product> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await apiRequest<unknown>(
        '/api/products',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-ProductSpy-Client': 'extension' },
          body: JSON.stringify(draftSchema.parse(draft)),
          signal: controller.signal,
        },
        WORKSPACE_URL,
      );
      const parsed = productSchema.safeParse(result);
      if (!parsed.success) {
        console.warn('[ProductSpy] Invalid workspace product', parsed.error);
        throw new Error('工作台返回的商品资料格式不正确。请更新 ProductSpy 并重试同步。');
      }
      return parsed.data;
    } catch (error: unknown) {
      console.error('[ProductSpy] Workspace sync failed', error);
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error(
          '暂时无法连接工作台。请在项目目录运行 pnpm dev，确认 http://127.0.0.1:3000 可访问后重试同步。',
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
