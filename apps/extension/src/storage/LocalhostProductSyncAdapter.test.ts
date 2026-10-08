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
const TOKEN_KEY = 'productspy.bridge-token.v1';
const TOKEN = 'a'.repeat(64);
const CODE = 'b'.repeat(32);

describe('LocalhostProductSyncAdapter', () => {
  let persisted: Record<string, unknown>;
  const get = vi.fn(async (key: string): Promise<Record<string, unknown>> => ({
    [key]: persisted[key],
  }));
  const set = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
    persisted = { ...persisted, ...structuredClone(items) };
  });
  const remove = vi.fn(async (key: string): Promise<void> => {
    delete persisted[key];
  });
  beforeEach(() => {
    persisted = { [TOKEN_KEY]: TOKEN };
    get.mockClear();
    set.mockClear();
    remove.mockClear();
    vi.stubGlobal('chrome', { storage: { local: { get, set, remove } } });
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
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      `Bearer ${TOKEN}`,
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

  it('keeps an unpaired capture local without contacting the workspace', async () => {
    persisted = {};
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const adapter = new LocalhostProductSyncAdapter();
    expect(await adapter.isPaired()).toBe(false);
    await expect(adapter.save(draft)).rejects.toThrow('请先打开工作台');
    expect(fetch).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it.each(['short', 'z'.repeat(64), 'A'.repeat(64), null, { token: TOKEN }])(
    'never sends an invalid stored credential %j',
    async (credential) => {
      persisted = { [TOKEN_KEY]: credential };
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const adapter = new LocalhostProductSyncAdapter();
      expect(await adapter.isPaired()).toBe(false);
      await expect(adapter.save(draft)).rejects.toThrow('请先打开工作台');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('pairs with a cleaned code and stores only the validated credential', async () => {
    persisted = {};
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true, data: { token: TOKEN } }),
    );
    vi.stubGlobal('fetch', fetch);
    const adapter = new LocalhostProductSyncAdapter();
    await adapter.pair(` ${CODE.toUpperCase()} `);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/bridge/pair',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: CODE }) }),
    );
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('X-ProductSpy-Client')).toBe('extension');
    expect(headers.has('Authorization')).toBe(false);
    expect(persisted).toEqual({ [TOKEN_KEY]: TOKEN });
    expect(await new LocalhostProductSyncAdapter().isPaired()).toBe(true);
  });

  it.each(['short', 'x'.repeat(32), 'b'.repeat(31), 'b'.repeat(33)])(
    'rejects invalid pairing code %s before any request',
    async (code) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(new LocalhostProductSyncAdapter().pair(code)).rejects.toThrow('完整配对码');
      expect(fetch).not.toHaveBeenCalled();
      expect(persisted).toEqual({ [TOKEN_KEY]: TOKEN });
    },
  );

  it.each([null, {}, { token: 123 }, { token: 'short' }, { token: 'z'.repeat(64) }])(
    'rejects invalid pairing response %j without replacing an existing credential',
    async (data) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ ok: true, data })),
      );
      await expect(new LocalhostProductSyncAdapter().pair(CODE)).rejects.toThrow('无效连接凭据');
      expect(set).not.toHaveBeenCalled();
      expect(persisted).toEqual({ [TOKEN_KEY]: TOKEN });
    },
  );

  it('forgets only a revoked credential on 401 and keeps queued captures intact', async () => {
    const queued = { products: {}, pending: { 'amazon:B012345678': draft } };
    persisted['productspy.local.v1'] = queued;
    const fetch = vi.fn(async () =>
      Response.json({ ok: false, error: 'Invalid bridge token' }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetch);
    const adapter = new LocalhostProductSyncAdapter();
    await expect(adapter.save(draft)).rejects.toThrow('待同步商品仍保留');
    expect(remove).toHaveBeenCalledExactlyOnceWith(TOKEN_KEY);
    expect(persisted).toEqual({ 'productspy.local.v1': queued });
    expect(await adapter.isPaired()).toBe(false);
    await expect(adapter.save(draft)).rejects.toThrow('请先打开工作台');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a credential after a server failure so a later retry can succeed', async () => {
    const product = mergeProduct(draft);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ok: false, error: '工作台存储暂时不可用' }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, data: product }));
    vi.stubGlobal('fetch', fetch);
    const adapter = new LocalhostProductSyncAdapter();
    await expect(adapter.save(draft)).rejects.toThrow('工作台存储暂时不可用');
    expect(remove).not.toHaveBeenCalled();
    expect(await adapter.isPaired()).toBe(true);
    expect(await adapter.save(draft)).toEqual(product);
  });
});
