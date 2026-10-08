import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as bootstrap } from '../../app/api/session/route';
import { POST as generateCode } from '../../app/api/bridge/code/route';
import { POST as pair, OPTIONS as pairOptions } from '../../app/api/bridge/pair/route';
import { POST as revoke } from '../../app/api/bridge/revoke/route';
import { GET as getStatus } from '../../app/api/bridge/status/route';
import { GET as listProducts } from '../../app/api/products/route';
import { assertLocalRequest, preflight } from './http';
import { generatePairCode, pairExtension, SESSION_COOKIE } from './auth';

const origin = 'http://127.0.0.1:3000';
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
const otherExtension = `chrome-extension://${'b'.repeat(32)}`;
const webContext = {
  origin,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  'x-productspy-client': 'web',
};

function webRequest(
  path: string,
  cookie = '',
  method = 'POST',
  overrides: Record<string, string> = {},
): Request {
  return new Request(`${origin}/api/${path}`, {
    method,
    headers: { ...webContext, cookie, ...overrides },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
}
function extensionRequest(
  path: string,
  body: unknown = {},
  token?: string,
  actualOrigin = extensionOrigin,
  method = 'POST',
): Request {
  return new Request(`${origin}/api/${path}`, {
    method,
    headers: {
      origin: actualOrigin,
      'content-type': 'application/json',
      'x-productspy-client': 'extension',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}
async function session(): Promise<string> {
  const response = await bootstrap(webRequest('session'));
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}
async function code(cookie: string): Promise<string> {
  const response = await generateCode(webRequest('bridge/code', cookie));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { code: string; expiresAt: string } };
  expect(body.data.code).toMatch(/^[a-f0-9]{32}$/);
  expect(Date.parse(body.data.expiresAt) - Date.now()).toBe(120_000);
  return body.data.code;
}
async function pairedToken(cookie: string, actualOrigin = extensionOrigin): Promise<string> {
  const response = await pair(
    extensionRequest('bridge/pair', { code: await code(cookie) }, undefined, actualOrigin),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { token: string } }).data.token;
}

describe('local sessions and bound extension pairing', () => {
  let directory: string;
  let now = Date.UTC(2030, 0, 1);
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-auth-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    now += 10 * 60_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('bootstraps only a same-origin web request and uses a protected host-only cookie', async () => {
    const response = await bootstrap(webRequest('session'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { authenticated: true } });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
    const invalidContexts: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'http://localhost:3000' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': '' },
      { 'x-productspy-client': 'extension' },
    ];
    for (const overrides of invalidContexts) {
      expect((await bootstrap(webRequest('session', '', 'POST', overrides))).status).toBe(403);
    }
    expect((await bootstrap(extensionRequest('session'))).status).toBe(403);
  });

  it('requires a valid host-bound cookie before any product read and allows same-origin GET without Origin', async () => {
    const cookie = await session();
    expect((await listProducts(webRequest('products', cookie, 'GET'))).status).toBe(200);
    expect((await listProducts(webRequest('products', cookie, 'GET', { origin: '' }))).status).toBe(
      200,
    );
    expect((await listProducts(webRequest('products', '', 'GET'))).status).toBe(401);
    expect(
      (await listProducts(webRequest('products', `${SESSION_COOKIE}=${'0'.repeat(64)}`, 'GET')))
        .status,
    ).toBe(401);
    const otherHost = new Request('http://localhost:3000/api/products', {
      headers: { ...webContext, origin: 'http://localhost:3000', cookie },
    });
    expect((await listProducts(otherHost)).status).toBe(401);
    now += 12 * 60 * 60_000 + 1;
    expect((await listProducts(webRequest('products', cookie, 'GET'))).status).toBe(401);
  });

  it('uses the actual loopback Host when Next normalizes request.url to localhost', async () => {
    const rewritten = new Request('http://localhost:3000/api/session', {
      method: 'POST',
      headers: { ...webContext, host: '127.0.0.1:3000' },
      body: '{}',
    });
    const response = await bootstrap(rewritten);
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    const read = new Request('http://localhost:3000/api/products', {
      headers: { ...webContext, host: '127.0.0.1:3000', cookie },
    });
    expect((await listProducts(read)).status).toBe(200);
    const otherHost = new Request('http://localhost:3000/api/products', {
      headers: { ...webContext, origin: 'http://localhost:3000', host: 'localhost:3000', cookie },
    });
    expect((await listProducts(otherHost)).status).toBe(401);
    const forgedOrigin = new Request('http://localhost:3000/api/session', {
      method: 'POST',
      headers: { ...webContext, origin: 'http://localhost:3000', host: '127.0.0.1:3000' },
      body: '{}',
    });
    expect((await bootstrap(forgedOrigin)).status).toBe(403);
    const foreignInternalUrl = new Request('http://evil.example:3000/api/session', {
      method: 'POST',
      headers: { ...webContext, host: '127.0.0.1:3000' },
      body: '{}',
    });
    expect((await bootstrap(foreignInternalUrl)).status).toBe(403);
    const foreignHost = new Request('http://localhost:3000/api/session', {
      method: 'POST',
      headers: { ...webContext, host: 'evil.example:3000' },
      body: '{}',
    });
    expect((await bootstrap(foreignHost)).status).toBe(403);
  });

  it('cannot use a forged extension Origin or fixed client label as authentication', async () => {
    expect(
      (
        await listProducts(
          extensionRequest('products', undefined, undefined, extensionOrigin, 'GET'),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await listProducts(
          extensionRequest('products', undefined, '0'.repeat(64), extensionOrigin, 'GET'),
        )
      ).status,
    ).toBe(401);
    const response = await generateCode(extensionRequest('bridge/code'));
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows only the pairing preflight before pairing and never exposes wildcard CORS', async () => {
    const headers = {
      origin: extensionOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'Content-Type, X-ProductSpy-Client, Authorization',
    };
    const allowed = await pairOptions(
      new Request(`${origin}/api/bridge/pair`, { method: 'OPTIONS', headers }),
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(extensionOrigin);
    const denied = await preflight(
      new Request(`${origin}/api/products`, { method: 'OPTIONS', headers }),
      ['POST'],
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('issues a single-use code and persists only a SHA256 token hash bound to the actual Origin', async () => {
    const cookie = await session();
    const pairingCode = await code(cookie);
    const response = await pair(extensionRequest('bridge/pair', { code: pairingCode }));
    const token = ((await response.json()) as { data: { token: string } }).data.token;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const file = await readFile(join(directory, '.bridge-credentials.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).not.toContain(pairingCode);
    expect(JSON.parse(file)).toMatchObject({ version: 1, extensionOrigin });
    expect(
      (await listProducts(extensionRequest('products', undefined, token, extensionOrigin, 'GET')))
        .status,
    ).toBe(200);
    const stolen = await listProducts(
      extensionRequest('products', undefined, token, otherExtension, 'GET'),
    );
    expect(stolen.status).toBe(401);
    expect(stolen.headers.get('access-control-allow-origin')).toBeNull();
    expect((await pair(extensionRequest('bridge/pair', { code: pairingCode }))).status).toBe(401);
    expect(await (await getStatus(webRequest('bridge/status', cookie, 'GET'))).json()).toEqual({
      ok: true,
      data: { paired: true },
    });
  });

  it('loads persisted credentials in a fresh data-directory state and rejects a changed on-disk token', async () => {
    const cookie = await session();
    const token = await pairedToken(cookie);
    const file = await readFile(join(directory, '.bridge-credentials.json'), 'utf8');
    const secondDirectory = await mkdtemp(join(tmpdir(), 'productspy-auth-restart-'));
    try {
      await writeFile(join(secondDirectory, '.bridge-credentials.json'), file);
      vi.stubEnv('PRODUCTSPY_DATA_DIR', secondDirectory);
      await expect(
        assertLocalRequest(extensionRequest('products', undefined, token, extensionOrigin, 'GET')),
      ).resolves.toBeUndefined();
      const changed = JSON.parse(file) as { tokenHash: string };
      changed.tokenHash = '0'.repeat(64);
      await writeFile(join(secondDirectory, '.bridge-credentials.json'), JSON.stringify(changed));
      await expect(
        assertLocalRequest(extensionRequest('products', undefined, token, extensionOrigin, 'GET')),
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
      await rm(secondDirectory, { recursive: true, force: true });
    }
  });

  it('loads paired credentials for the very first OPTIONS request after a cold auth registry restart', async () => {
    const token = 'c'.repeat(64);
    await writeFile(
      join(directory, '.bridge-credentials.json'),
      JSON.stringify({
        version: 1,
        extensionOrigin,
        tokenHash: createHash('sha256').update(token).digest('hex'),
      }),
    );
    const authGlobal = globalThis as typeof globalThis & { __productspyAuth?: unknown };
    const previousRegistry = authGlobal.__productspyAuth;
    delete authGlobal.__productspyAuth;
    vi.resetModules();
    try {
      const coldHttp = await import('./http');
      expect(coldHttp.isAllowedOrigin(extensionOrigin)).toBe(false);
      const response = await coldHttp.preflight(
        new Request(`${origin}/api/products`, {
          method: 'OPTIONS',
          headers: {
            origin: extensionOrigin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'Authorization,Content-Type,X-ProductSpy-Client',
            'access-control-request-private-network': 'true',
          },
        }),
        ['GET', 'POST'],
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(extensionOrigin);
      expect(response.headers.get('access-control-allow-private-network')).toBe('true');
      await expect(
        coldHttp.assertLocalRequest(
          extensionRequest('products', undefined, token, extensionOrigin, 'GET'),
        ),
      ).resolves.toBeUndefined();
      const denied = await coldHttp.preflight(
        new Request(`${origin}/api/products`, {
          method: 'OPTIONS',
          headers: { origin: otherExtension, 'access-control-request-method': 'GET' },
        }),
        ['GET'],
      );
      expect(denied.status).toBe(403);
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      authGlobal.__productspyAuth = previousRegistry;
      vi.resetModules();
    }
  });

  it('reuses a valid session instead of minting more tokens and limits new sessions per minute', async () => {
    const cookie = await session();
    const reused = await bootstrap(webRequest('session', cookie));
    expect(reused.headers.get('set-cookie')?.split(';')[0]).toBe(cookie);
    for (let index = 1; index < 30; index++)
      expect((await bootstrap(webRequest('session'))).status).toBe(200);
    expect((await bootstrap(webRequest('session'))).status).toBe(429);
    expect((await bootstrap(webRequest('session', cookie))).status).toBe(200);
    now += 60_001;
    expect((await bootstrap(webRequest('session'))).status).toBe(200);
  });

  it('bounds active sessions without evicting valid sessions and reclaims expired sessions', async () => {
    const cookie = await session();
    for (let index = 1; index < 128; index++) {
      if (index % 20 === 0) now += 60_001;
      expect((await bootstrap(webRequest('session'))).status).toBe(200);
    }
    expect((await bootstrap(webRequest('session'))).status).toBe(429);
    expect((await listProducts(webRequest('products', cookie, 'GET'))).status).toBe(200);
    expect((await bootstrap(webRequest('session', cookie))).status).toBe(200);
    now += 12 * 60 * 60_000 + 1;
    expect((await bootstrap(webRequest('session'))).status).toBe(200);
    expect((await listProducts(webRequest('products', cookie, 'GET'))).status).toBe(401);
  });

  it('revokes the previous token on a new pairing and clears unused codes when revoked', async () => {
    const cookie = await session();
    const first = await pairedToken(cookie);
    const second = await pairedToken(cookie, otherExtension);
    expect(
      (await listProducts(extensionRequest('products', undefined, first, extensionOrigin, 'GET')))
        .status,
    ).toBe(401);
    expect(
      (await listProducts(extensionRequest('products', undefined, second, otherExtension, 'GET')))
        .status,
    ).toBe(200);
    const unused = await code(cookie);
    expect((await revoke(webRequest('bridge/revoke', cookie))).status).toBe(200);
    expect(
      (await listProducts(extensionRequest('products', undefined, second, otherExtension, 'GET')))
        .status,
    ).toBe(401);
    expect((await pair(extensionRequest('bridge/pair', { code: unused }))).status).toBe(401);
    expect(await (await getStatus(webRequest('bridge/status', cookie, 'GET'))).json()).toEqual({
      ok: true,
      data: { paired: false },
    });
  });

  it('expires pairing codes and permits only one concurrent successful exchange', async () => {
    const cookie = await session();
    const expired = await code(cookie);
    now += 120_001;
    expect((await pair(extensionRequest('bridge/pair', { code: expired }))).status).toBe(401);
    const active = await code(cookie);
    const responses = await Promise.all([
      pair(extensionRequest('bridge/pair', { code: active })),
      pair(extensionRequest('bridge/pair', { code: active })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it('preserves malformed credentials and user products, while allowing an authenticated revoke to recover', async () => {
    const cookie = await session();
    const products = '[{"user":"must remain untouched"}]';
    await writeFile(join(directory, 'products.json'), products);
    await writeFile(join(directory, '.bridge-credentials.json'), '{broken');
    expect((await getStatus(webRequest('bridge/status', cookie, 'GET'))).status).toBe(500);
    expect(await readFile(join(directory, '.bridge-credentials.json'), 'utf8')).toBe('{broken');
    expect((await revoke(webRequest('bridge/revoke', cookie))).status).toBe(200);
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe(products);
  });

  it('rate-limits failed pairing attempts globally without including secrets in errors', async () => {
    for (let attempt = 0; attempt < 10; attempt++)
      await expect(pairExtension(extensionOrigin, '0'.repeat(32))).rejects.toMatchObject({
        status: 401,
      });
    await expect(pairExtension(extensionOrigin, generatePairCode().code)).rejects.toMatchObject({
      status: 429,
    });
    now += 60_001;
    await expect(pairExtension(extensionOrigin, generatePairCode().code)).resolves.toMatchObject({
      token: expect.any(String),
    });
  });
});
