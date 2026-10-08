import { describe, expect, it, vi } from 'vitest';
import { AppError } from './errors';
import {
  assertLocalRequest,
  isAllowedOrigin,
  preflight,
  readJsonBody,
  withApiRequest,
} from './http';

const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
function request(
  method = 'POST',
  overrides: Record<string, string> = {},
  body = '{"hello":"world"}',
): Request {
  return new Request('http://localhost:3000/api/products', {
    method,
    headers: {
      origin: 'http://localhost:3000',
      'content-type': 'application/json',
      'x-productspy-client': 'web',
      ...overrides,
    },
    ...(method === 'GET' || method === 'OPTIONS' ? {} : { body }),
  });
}

describe('local API request protection', () => {
  it('accepts only exact local origins or unpacked Chrome extension origins', () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedOrigin(extensionOrigin)).toBe(true);
    for (const origin of [
      'https://evil.example',
      'http://localhost:3000.evil.example',
      'http://localhost:4000',
      'chrome-extension://bad',
      'null',
    ]) {
      expect(isAllowedOrigin(origin)).toBe(false);
    }
  });

  it('permits local reads without Origin but denies external Host or Origin', () => {
    expect(() =>
      assertLocalRequest(new Request('http://127.0.0.1:3000/api/products')),
    ).not.toThrow();
    expect(() => assertLocalRequest(request('GET', { host: 'evil.example' }))).toThrow(AppError);
    expect(() => assertLocalRequest(request('GET', { origin: 'https://evil.example' }))).toThrow(
      AppError,
    );
  });

  it('rejects writes without Origin, client header, or application/json', () => {
    const noOrigin = new Request('http://localhost:3000/api/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-productspy-client': 'web' },
      body: '{}',
    });
    expect(() => assertLocalRequest(noOrigin, true)).toThrow('来源');
    expect(() => assertLocalRequest(request('POST', { 'x-productspy-client': '' }), true)).toThrow(
      'ProductSpy',
    );
    expect(() =>
      assertLocalRequest(request('POST', { 'content-type': 'text/plain' }), true),
    ).toThrow('JSON');
    expect(() =>
      assertLocalRequest(
        request('POST', { origin: extensionOrigin, 'x-productspy-client': 'extension' }),
        true,
      ),
    ).not.toThrow();
  });

  it('returns reflected CORS and supports private-network preflight', () => {
    const response = preflight(
      request('OPTIONS', {
        origin: extensionOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Content-Type, X-ProductSpy-Client',
        'access-control-request-private-network': 'true',
      }),
      ['GET', 'POST'],
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(extensionOrigin);
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('access-control-allow-private-network')).toBe('true');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('rejects unsupported preflight methods and headers', () => {
    expect(
      preflight(request('OPTIONS', { 'access-control-request-method': 'PUT' }), ['GET', 'POST'])
        .status,
    ).toBe(405);
    expect(
      preflight(
        request('OPTIONS', {
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'Authorization',
        }),
        ['GET', 'POST'],
      ).status,
    ).toBe(403);
    const denied = preflight(
      request('OPTIONS', {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      }),
      ['GET', 'POST'],
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('validates JSON and limits actual UTF-8 body bytes independently of Content-Length', async () => {
    expect(await readJsonBody(request())).toEqual({ hello: 'world' });
    await expect(readJsonBody(request('POST', {}, '{broken'))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      readJsonBody(request('POST', { 'content-length': `${1024 * 1024 + 1}` }, '{}')),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readJsonBody(request('POST', { 'content-length': '1' }, '中'.repeat(350000))),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('returns consistent success/errors without revealing internal exceptions', async () => {
    const success = await withApiRequest(request(), () => ({ id: 'product' }), { write: true });
    expect(await success.json()).toEqual({ ok: true, data: { id: 'product' } });
    const knownError = await withApiRequest(
      request(),
      () => {
        throw new AppError(409, '商品已更新');
      },
      { write: true },
    );
    expect(knownError.status).toBe(409);
    expect(await knownError.json()).toEqual({ ok: false, error: '商品已更新' });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const internal = await withApiRequest(
      request(),
      () => {
        throw new Error('private detail');
      },
      { write: true },
    );
    expect(internal.status).toBe(500);
    expect(JSON.stringify(await internal.json())).not.toContain('private detail');
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });
});
