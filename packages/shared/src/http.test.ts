import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';

afterEach(() => vi.unstubAllGlobals());
describe('shared workspace HTTP client', () => {
  it.each([
    { 'X-ProductSpy-Client': 'extension' },
    new Headers({ 'X-ProductSpy-Client': 'extension' }),
    [['X-ProductSpy-Client', 'extension']] as [string, string][],
  ])('preserves custom headers in every RequestInit format', async (headers) => {
    const request = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ ok: true, data: { saved: true } }),
    );
    vi.stubGlobal('fetch', request);
    expect(await apiRequest('/api/products', { method: 'POST', headers })).toEqual({ saved: true });
    const received = new Headers(request.mock.calls[0]?.[1].headers);
    expect(received.get('X-ProductSpy-Client')).toBe('extension');
    expect(received.get('Content-Type')).toBe('application/json');
  });
  it('turns wrong-port HTML responses into readable errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>not ProductSpy</html>')),
    );
    await expect(apiRequest('/api/products')).rejects.toThrow('3000 端口');
  });
  it('preserves a server error without claiming success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: false, error: '商品已更新' }, { status: 409 })),
    );
    await expect(apiRequest('/api/products')).rejects.toThrow('商品已更新');
  });
});
