import { mergeProduct, type ProductDraft } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalhostProductSyncAdapter } from './LocalhostProductSyncAdapter';

const draft: ProductDraft = {
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Travel bottle',
  images: [],
  videos: [],
  bulletPoints: [],
};

describe('LocalhostProductSyncAdapter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts a validated capture to the local workspace using the extension client header', async () => {
    const product = mergeProduct(draft);
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true, data: product }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await new LocalhostProductSyncAdapter().save(draft)).toEqual(product);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/products',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(draft),
      }),
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('X-ProductSpy-Client')).toBe(
      'extension',
    );
  });

  it('rejects invalid server data instead of acknowledging a successful save', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, data: { id: 'incomplete' } })),
    );
    await expect(new LocalhostProductSyncAdapter().save(draft)).rejects.toThrow('格式不正确');
  });

  it('provides a readable error when localhost is not running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(new LocalhostProductSyncAdapter().save(draft)).rejects.toThrow('启动 pnpm dev');
  });

  it('preserves readable API errors and validates input before contacting the workspace', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ ok: false, error: '商品信息格式无效' }, { status: 400 }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(new LocalhostProductSyncAdapter().save(draft)).rejects.toThrow('商品信息格式无效');
    fetch.mockClear();
    await expect(
      new LocalhostProductSyncAdapter().save({ ...draft, sourceId: 'bad' }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
