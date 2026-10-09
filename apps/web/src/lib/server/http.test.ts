import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from './errors';
import { generatePairCode, pairExtension } from './auth';
import { webHeaders } from './test-auth';
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
    headers: { ...webHeaders(), ...overrides },
    ...(method === 'GET' || method === 'OPTIONS' ? {} : { body }),
  });
}

describe('local API request protection', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-http-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('allows exact local origins and only the paired Chrome extension origin', async () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedOrigin(extensionOrigin)).toBe(false);
    await pairExtension(extensionOrigin, generatePairCode().code);
    expect(isAllowedOrigin(extensionOrigin)).toBe(true);
    for (const origin of [
      'https://evil.example',
      'http://localhost:3000.evil.example',
      'http://localhost:4000',
      'chrome-extension://bad',
      `chrome-extension://${'b'.repeat(32)}`,
      'null',
    ])
      expect(isAllowedOrigin(origin)).toBe(false);
  });

  it('requires an authenticated session for reads and denies external Host or Origin', async () => {
    await expect(assertLocalRequest(request('GET'))).resolves.toBeUndefined();
    await expect(assertLocalRequest(request('GET', { cookie: '' }))).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      assertLocalRequest(request('GET', { host: 'evil.example' })),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      assertLocalRequest(request('GET', { origin: 'https://evil.example' })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      assertLocalRequest(request('GET', { origin: 'http://127.0.0.1:3000' })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      assertLocalRequest(request('GET', { 'sec-fetch-site': 'cross-site' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects writes without Origin, client header, or application/json', async () => {
    await expect(assertLocalRequest(request('POST', { origin: '' }), true)).rejects.toThrow('来源');
    await expect(
      assertLocalRequest(request('POST', { 'x-productspy-client': '' }), true),
    ).rejects.toThrow('ProductSpy');
    await expect(
      assertLocalRequest(request('POST', { 'content-type': 'text/plain' }), true),
    ).rejects.toThrow('JSON');
    const { token } = await pairExtension(extensionOrigin, generatePairCode().code);
    await expect(
      assertLocalRequest(
        request('POST', {
          origin: extensionOrigin,
          'x-productspy-client': 'extension',
          authorization: `Bearer ${token}`,
        }),
        true,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertLocalRequest(
        request('POST', { origin: extensionOrigin, 'x-productspy-client': 'extension' }),
        true,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('supports Authorization and private-network preflight only for paired extensions', async () => {
    await pairExtension(extensionOrigin, generatePairCode().code);
    const response = await preflight(
      request('OPTIONS', {
        origin: extensionOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Content-Type, X-ProductSpy-Client, Authorization',
        'access-control-request-private-network': 'true',
      }),
      ['GET', 'POST'],
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(extensionOrigin);
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('access-control-allow-private-network')).toBe('true');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    const denied = await preflight(
      request('OPTIONS', {
        origin: `chrome-extension://${'b'.repeat(32)}`,
        'access-control-request-method': 'POST',
      }),
      ['GET', 'POST'],
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects unsupported preflight methods and headers', async () => {
    expect(
      (
        await preflight(request('OPTIONS', { 'access-control-request-method': 'PUT' }), [
          'GET',
          'POST',
        ])
      ).status,
    ).toBe(405);
    expect(
      (
        await preflight(
          request('OPTIONS', {
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'X-Unknown',
          }),
          ['GET', 'POST'],
        )
      ).status,
    ).toBe(403);
    const denied = await preflight(
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

  it('returns consistent success/errors without revealing internal exceptions or executing unauthorized operations', async () => {
    const success = await withApiRequest(request(), () => ({ id: 'product' }), { write: true });
    expect(await success.json()).toEqual({ ok: true, data: { id: 'product' } });
    const operation = vi.fn();
    const denied = await withApiRequest(request('POST', { cookie: '' }), operation, {
      write: true,
    });
    expect(denied.status).toBe(401);
    expect(operation).not.toHaveBeenCalled();
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

  it('only emits bounded numeric Retry-After values from rate-limit errors', async () => {
    for (const [value, expected] of [
      [1.2, '2'],
      [9999999, '86400'],
      [NaN, null],
      [Infinity, null],
      [-5, null],
      ['10\r\nInjected: header', null],
    ] as const) {
      const error = Object.assign(new AppError(429, '请求限流'), { retryAfterSeconds: value });
      const response = await withApiRequest(
        request(),
        () => {
          throw error;
        },
        { write: true },
      );
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe(expected);
    }
    const response = await withApiRequest(
      request(),
      () => {
        throw Object.assign(new AppError(502, '服务异常'), { retryAfterSeconds: 10 });
      },
      { write: true },
    );
    expect(response.headers.get('retry-after')).toBeNull();
  });
});
