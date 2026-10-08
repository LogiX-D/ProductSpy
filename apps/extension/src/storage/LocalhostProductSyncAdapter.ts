import { ApiRequestError, apiRequest, draftSchema, productSchema } from '@productspy/shared';
import type { Product, ProductDraft, ProductSyncAdapter } from '@productspy/shared';
import { WORKSPACE_URL } from '../background/messages';
import { bridgeToken, forgetBridgeToken, rememberBridgeToken } from './bridge-credentials';

export class LocalhostProductSyncAdapter implements ProductSyncAdapter {
  async isPaired(): Promise<boolean> {
    return Boolean(await bridgeToken());
  }

  async pair(code: string): Promise<void> {
    const cleaned = code.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(cleaned)) throw new Error('请粘贴工作台生成的完整配对码。');
    const result = await apiRequest<unknown>(
      '/api/bridge/pair',
      {
        method: 'POST',
        headers: { 'X-ProductSpy-Client': 'extension' },
        body: JSON.stringify({ code: cleaned }),
      },
      WORKSPACE_URL,
    );
    if (
      !result ||
      typeof result !== 'object' ||
      !('token' in result) ||
      typeof result.token !== 'string'
    )
      throw new Error('工作台返回了无效连接凭据，请重试配对。');
    await rememberBridgeToken(result.token);
  }

  async save(draft: ProductDraft): Promise<Product> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const token = await bridgeToken();
      if (!token)
        throw new Error(
          '请先打开工作台，在扩展安装说明中生成配对码，再连接插件。商品会保留在插件待同步列表。',
        );
      const result = await apiRequest<unknown>(
        '/api/products',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-ProductSpy-Client': 'extension',
            Authorization: `Bearer ${token}`,
          },
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
      if (error instanceof ApiRequestError && error.status === 401) {
        await forgetBridgeToken();
        throw new Error('工作台连接凭据已失效，请重新配对。待同步商品仍保留在插件中。');
      }
      console.error('[ProductSpy] Workspace sync failed', error);
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error(
          '暂时无法连接工作台。请双击 ProductSpy.cmd 启动；开发者可运行 pnpm dev。确认 http://127.0.0.1:3000 可访问后重试同步。',
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
