import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PRODUCTSPY_EXTENSION_ID, type ApiResult } from '@productspy/shared';
import { POST, OPTIONS } from '../../app/api/bridge/connect/route';
import { POST as register } from '../../app/api/auth/register/route';
import { POST as capture, GET as products } from '../../app/api/products/route';
import { closeDatabase, ensureDatabase, query } from './database';
import { tokenHash } from './security';
import * as context from './context';

const origin = 'http://127.0.0.1:3000';
const extension = `chrome-extension://${PRODUCTSPY_EXTENSION_ID}`;
const otherExtension = `chrome-extension://${'a'.repeat(32)}`;
const runId = randomUUID();
interface Account {
  user: { id: string; email: string; name: string };
  cookie: string;
}
interface Connection {
  token: string;
  expiresAt: string;
  user: Account['user'];
}
let directory: string;
let alice: Account, bob: Account;
const accounts: Account[] = [];

function webRequest(path: string, method: string, body?: unknown, cookie = '') {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      host: '127.0.0.1:3000',
      origin,
      'content-type': 'application/json',
      'x-productspy-client': 'web',
      cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function request(
  cookie = '',
  token?: string,
  headers: Record<string, string> = {},
  body: unknown = {},
) {
  return new Request(`${origin}/api/bridge/connect`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin: extension,
      'content-type': 'application/json',
      'x-productspy-client': 'extension',
      ...(cookie ? { cookie } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
async function data<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as ApiResult<T>;
  if (!envelope.ok) throw new Error(`${response.status}: ${envelope.error}`);
  return envelope.data;
}
async function newAccount(label: string): Promise<Account> {
  const response = await register(
    webRequest('/api/auth/register', 'POST', {
      email: `${label}-${runId}@example.invalid`,
      name: label,
      password: 'Synthetic-extension-connect-2026',
    }),
  );
  expect(response.status).toBe(200);
  const result = {
    user: (await data<{ user: Account['user'] }>(response)).user,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
  };
  accounts.push(result);
  return result;
}
async function connect(account: Account, token?: string) {
  const response = await POST(request(account.cookie, token));
  expect(response.status).toBe(200);
  return data<Connection>(response);
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'productspy-extension-connect-'));
  vi.stubEnv('PRODUCTSPY_MODE', 'saas');
  vi.stubEnv('PRODUCTSPY_APP_URL', origin);
  vi.stubEnv('PRODUCTSPY_EXTENSION_IDS', PRODUCTSPY_EXTENSION_ID);
  if (process.env.PRODUCTSPY_TEST_DATABASE_URL) {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pg');
    vi.stubEnv('DATABASE_URL', process.env.PRODUCTSPY_TEST_DATABASE_URL);
    vi.stubEnv('PRODUCTSPY_AUTO_MIGRATE', process.env.PRODUCTSPY_TEST_AUTO_MIGRATE ?? '0');
  } else {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pglite');
    vi.stubEnv('PRODUCTSPY_PGLITE_DIR', join(directory, 'database'));
  }
  await ensureDatabase();
  alice = await newAccount('auto-alice');
  bob = await newAccount('auto-bob');
}, 30000);
afterEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv('PRODUCTSPY_EXTENSION_IDS', PRODUCTSPY_EXTENSION_ID);
  vi.stubEnv('PRODUCTSPY_MODE', 'saas');
});
afterAll(async () => {
  if (accounts.length)
    await query('DELETE FROM users WHERE id=ANY($1::text[])', [
      accounts.map((account) => account.user.id),
    ]);
  await closeDatabase();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('cookie-backed current-account connection (real database, no Chrome cookie acceptance implied)', () => {
  it('issues only an origin-bound extension session from an independently valid web Cookie', async () => {
    const response = await POST(request(alice.cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(extension);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
    const result = await data<Connection>(response);
    expect(result.user.id).toBe(alice.user.id);
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(result.token).not.toBe(alice.cookie.split('=')[1]);
    const saved = await query<{ user_id: string; kind: string; extension_origin: string }>(
      'SELECT user_id,kind,extension_origin FROM sessions WHERE token_hash=$1',
      [tokenHash(result.token)],
    );
    expect(saved.rows).toEqual([
      { user_id: alice.user.id, kind: 'extension', extension_origin: extension },
    ]);
  });
  it('reuses the same active token without growing sessions or audit rows on routine checks', async () => {
    const first = await connect(alice);
    const before = await query<{ count: string }>(
      'SELECT count(*) AS count FROM sessions WHERE user_id=$1',
      [alice.user.id],
    );
    const auditBefore = await context.withTenant(alice.user.id, () =>
      query<{ count: string }>('SELECT count(*) AS count FROM audit_events WHERE user_id=$1', [
        alice.user.id,
      ]),
    );
    const second = await connect(alice, first.token);
    const third = await connect(alice, second.token);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(
      (
        await query<{ count: string }>('SELECT count(*) AS count FROM sessions WHERE user_id=$1', [
          alice.user.id,
        ])
      ).rows,
    ).toEqual(before.rows);
    const auditAfter = await context.withTenant(alice.user.id, () =>
      query<{ count: string }>('SELECT count(*) AS count FROM audit_events WHERE user_id=$1', [
        alice.user.id,
      ]),
    );
    expect(auditAfter.rows).toEqual(auditBefore.rows);
  });
  it('selects the new web account and never trusts the prior extension token as owner', async () => {
    const old = await connect(alice);
    const current = await connect(bob, old.token);
    expect(current.user.id).toBe(bob.user.id);
    expect(current.token).not.toBe(old.token);
    expect(
      (
        await query<{ user_id: string }>('SELECT user_id FROM sessions WHERE token_hash=$1', [
          tokenHash(old.token),
        ])
      ).rows[0].user_id,
    ).toBe(alice.user.id);
  });
  it.each(['revoked', 'expired'] as const)(
    'replaces a %s extension session without resurrecting it',
    async (reason) => {
      const first = await connect(alice);
      await query(
        reason === 'revoked'
          ? 'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND user_id=$2'
          : "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1 AND user_id=$2",
        [tokenHash(first.token), alice.user.id],
      );
      const next = await connect(alice, first.token);
      expect(next.token).not.toBe(first.token);
    },
  );
  it('does not reuse an extension session bound to a different allowed extension origin', async () => {
    const first = await connect(alice);
    vi.stubEnv('PRODUCTSPY_EXTENSION_IDS', `${PRODUCTSPY_EXTENSION_ID},${'a'.repeat(32)}`);
    const response = await POST(request(alice.cookie, first.token, { origin: otherExtension }));
    const next = await data<Connection>(response);
    expect(next.token).not.toBe(first.token);
    expect(
      (
        await query<{ extension_origin: string }>(
          'SELECT extension_origin FROM sessions WHERE token_hash=$1',
          [tokenHash(next.token)],
        )
      ).rows[0].extension_origin,
    ).toBe(otherExtension);
  });
  it.each<Record<string, string>>([
    {},
    { authorization: `Bearer ${'a'.repeat(64)}` },
    { cookie: `productspy_account=${'b'.repeat(64)}` },
  ])(
    'rejects missing/unknown web authentication even when a bearer header exists (%j)',
    async (headers) => {
      expect((await POST(request('', undefined, headers))).status).toBe(401);
    },
  );
  it('rejects an extension token masquerading as the web Cookie', async () => {
    const ext = await connect(alice);
    expect((await POST(request(`productspy_account=${ext.token}`, ext.token))).status).toBe(401);
  });
  it('rejects duplicated account cookies instead of choosing an ambiguous identity', async () => {
    expect((await POST(request(`${alice.cookie}; ${bob.cookie}`))).status).toBe(401);
  });
  it.each(['revoked', 'expired'] as const)(
    'rejects a %s web session despite an otherwise active extension token',
    async (reason) => {
      const account = await newAccount(`web-${reason}`);
      const first = await connect(account);
      const hash = tokenHash(account.cookie.split('=')[1]);
      await query(
        reason === 'revoked'
          ? 'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND user_id=$2'
          : "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1 AND user_id=$2",
        [hash, account.user.id],
      );
      expect((await POST(request(account.cookie, first.token))).status).toBe(401);
    },
  );
  it.each(['', origin, otherExtension, `${extension}.evil.test`, 'https://evil.example'])(
    'rejects an untrusted origin without credentialed CORS (%s)',
    async (selected) => {
      const response = await POST(request(alice.cookie, undefined, { origin: selected }));
      expect(response.status).toBe(403);
      expect(response.headers.has('access-control-allow-origin')).toBe(false);
      expect(response.headers.has('access-control-allow-credentials')).toBe(false);
      expect(JSON.stringify(await response.json())).not.toContain(alice.user.email);
    },
  );
  it.each<Record<string, string>>([
    { host: 'evil.example' },
    { 'x-productspy-client': 'web' },
    { 'content-type': 'text/plain' },
  ])('rejects wrong host/client/content type before issuing a token (%j)', async (headers) => {
    const response = await POST(request(alice.cookie, undefined, headers));
    expect([403, 415]).toContain(response.status);
    expect(JSON.stringify(await response.json())).not.toContain(alice.user.email);
  });
  it('rejects client-supplied owner/plan and malformed Authorization parameters', async () => {
    expect(
      (await POST(request(alice.cookie, undefined, {}, { userId: bob.user.id, plan: 'pro' })))
        .status,
    ).toBe(400);
    expect(
      (await POST(request(alice.cookie, undefined, { authorization: 'Bearer invalid' }))).status,
    ).toBe(400);
  });
  it.each(['', `${PRODUCTSPY_EXTENSION_ID},`, '*', 'not-an-extension'])(
    'fails closed for malformed extension allowlist configuration (%s)',
    async (configured) => {
      vi.stubEnv('PRODUCTSPY_EXTENSION_IDS', configured);
      const response = await POST(request(alice.cookie));
      expect(response.status).toBe(503);
      expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    },
  );
  it('rejects web session revocation that wins the tenant lock after the initial identity read', async () => {
    const account = await newAccount('lock-race');
    const original = context.withTenant;
    vi.spyOn(context, 'withTenant').mockImplementationOnce((id, operation) =>
      original(id, async () => {
        await query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [id]);
        return operation();
      }),
    );
    expect((await POST(request(account.cookie))).status).toBe(401);
    expect(
      Number(
        (
          await query<{ count: string }>(
            'SELECT count(*) AS count FROM sessions WHERE user_id=$1 AND kind=$2',
            [account.user.id, 'extension'],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
  });
  it('retains user-scoped capture data and never grants Pro or consumes AI quota while connecting', async () => {
    const a = await connect(alice);
    const b = await connect(bob);
    const draft = {
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Alice capture',
      images: [],
      videos: [],
      bulletPoints: [],
    };
    const saved = await capture(
      new Request(`${origin}/api/products`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3000',
          origin: extension,
          'content-type': 'application/json',
          'x-productspy-client': 'extension',
          authorization: `Bearer ${a.token}`,
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify(draft),
      }),
    );
    expect(saved.status).toBe(200);
    const listedA = await data<Array<{ title: string }>>(
      await products(webRequest('/api/products', 'GET', undefined, alice.cookie)),
    );
    const listedB = await data<Array<{ title: string }>>(
      await products(webRequest('/api/products', 'GET', undefined, bob.cookie)),
    );
    expect(listedA.map((product) => product.title)).toContain('Alice capture');
    expect(listedB).toEqual([]);
    expect(b.user.id).toBe(bob.user.id);
    const summary = await context.withTenant(alice.user.id, async () => ({
      plans: (
        await query<{ plan: string }>('SELECT plan FROM subscriptions WHERE user_id=$1', [
          alice.user.id,
        ])
      ).rows,
      usage: (
        await query<{ count: string }>(
          'SELECT count(*) AS count FROM usage_events WHERE user_id=$1',
          [alice.user.id],
        )
      ).rows,
    }));
    expect(summary.plans).toEqual([{ plan: 'free' }]);
    expect(Number(summary.usage[0].count)).toBe(0);
  });
  it('does not enable this connection API for legacy mode', async () => {
    vi.stubEnv('PRODUCTSPY_MODE', 'legacy');
    expect((await POST(request(alice.cookie))).status).toBe(404);
  });
});

describe('exact credentialed extension preflight', () => {
  function preflight(
    selected = extension,
    method = 'POST',
    headers = 'content-type,x-productspy-client,authorization',
  ) {
    return OPTIONS(
      new Request(`${origin}/api/bridge/connect`, {
        method: 'OPTIONS',
        headers: {
          host: '127.0.0.1:3000',
          origin: selected,
          'access-control-request-method': method,
          'access-control-request-headers': headers,
        },
      }),
    );
  }
  it('allows only the listed extension, method and minimal headers without needing a Cookie', async () => {
    const response = await preflight();
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(extension);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
  });
  it('rejects unlisted extension, web origin, unsupported method and extra headers', async () => {
    expect((await preflight(otherExtension)).status).toBe(403);
    expect((await preflight(origin)).status).toBe(403);
    expect((await preflight(extension, 'GET')).status).toBe(405);
    expect((await preflight(extension, 'POST', 'x-user-id')).status).toBe(403);
  });
});
