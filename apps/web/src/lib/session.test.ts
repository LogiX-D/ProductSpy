import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function success(data: unknown = null): Response {
  return Response.json({ ok: true, data });
}
function failure(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

describe('authenticated web requests', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('shares a single bootstrap between concurrent operations and reuses the session', async () => {
    let release: ((response: Response) => void) | undefined;
    const bootstrap = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url === '/api/session' ? bootstrap : success({ url }),
    );
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    const concurrent = [
      '/api/products',
      '/api/bridge/code',
      '/api/products/amazon%3AB012345678',
    ].map((url) => webRequest<{ url: string }>(url));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/session']);
    release?.(success());
    expect(await Promise.all(concurrent)).toEqual([
      { url: '/api/products' },
      { url: '/api/bridge/code' },
      { url: '/api/products/amazon%3AB012345678' },
    ]);
    await webRequest('/api/products');
    expect(fetch.mock.calls.filter(([url]) => url === '/api/session')).toHaveLength(1);
    for (const [, init] of fetch.mock.calls) expect(init?.credentials).toBe('same-origin');
  });

  it('renews an expired session and retries a business operation exactly once on 401', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(failure(401, 'Session expired'))
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success({ saved: true }));
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    const init: RequestInit = { method: 'POST', body: JSON.stringify({ title: 'Bottle' }) };
    expect(await webRequest('/api/products', init)).toEqual({ saved: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/session',
      '/api/products',
      '/api/session',
      '/api/products',
    ]);
    expect(fetch.mock.calls[1]?.[1].body).toBe(init.body);
    expect(fetch.mock.calls[3]?.[1].body).toBe(init.body);
  });

  it('does not loop when the single renewed-session retry is also rejected', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(failure(401, 'Session expired'))
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(failure(401, 'Session still invalid'));
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    await expect(webRequest('/api/products')).rejects.toThrow('Session still invalid');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('coalesces renewal when concurrent reads encounter the same expired session', async () => {
    let rejected = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/session') return success();
      if (rejected < 2) {
        rejected += 1;
        return failure(401, 'Session expired');
      }
      return success({ recovered: true });
    });
    vi.stubGlobal('fetch', fetch);
    const { ensureSession, webRequest } = await import('./session');
    await ensureSession();
    expect(
      await Promise.all([webRequest('/api/products'), webRequest('/api/products/fixture')]),
    ).toEqual([{ recovered: true }, { recovered: true }]);
    expect(fetch.mock.calls.filter(([url]) => url === '/api/session')).toHaveLength(2);
  });

  it('does not retry an unsuccessful business operation on 503', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(failure(503, 'AI temporarily unavailable'));
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    await expect(
      webRequest('/api/analyze-product', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('AI temporarily unavailable');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/session', '/api/analyze-product']);
  });

  it('can recover from a failed bootstrap without sending the first business request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failure(503, 'Session temporarily unavailable'))
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success({ products: [] }));
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    await expect(webRequest('/api/products')).rejects.toThrow('Session temporarily unavailable');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/session']);
    expect(await webRequest('/api/products')).toEqual({ products: [] });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/session',
      '/api/session',
      '/api/products',
    ]);
  });

  it('authenticates media fetches and retries once after canceling a rejected response', async () => {
    const unauthorized = new Response('Unauthorized', { status: 401 });
    const cancel = vi.spyOn(unauthorized.body!, 'cancel');
    const bytes = new Uint8Array([1, 2, 3]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetch);
    const { webFetch } = await import('./session');
    const response = await webFetch('/api/media?url=fixture', { headers: { 'X-Test': 'kept' } });
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/session',
      '/api/media?url=fixture',
      '/api/session',
      '/api/media?url=fixture',
    ]);
    for (const index of [1, 3]) {
      const headers = new Headers(fetch.mock.calls[index]?.[1].headers);
      expect(headers.get('X-ProductSpy-Client')).toBe('web');
      expect(headers.get('X-Test')).toBe('kept');
      expect(fetch.mock.calls[index]?.[1].credentials).toBe('same-origin');
    }
  });
});
