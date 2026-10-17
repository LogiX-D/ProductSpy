import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  type ApiResult,
  type Product,
  type WorkspaceBackup,
} from '@productspy/shared';
import { closeDatabase, dbTransaction, ensureDatabase, query } from './database';
import { withTenant, withTenantRead } from './context';
import * as security from './security';
import { POST as register } from '../../app/api/auth/register/route';
import { POST as login } from '../../app/api/auth/login/route';
import { POST as logout } from '../../app/api/auth/logout/route';
import { POST as password } from '../../app/api/auth/password/route';
import { GET as me } from '../../app/api/auth/me/route';
import { POST as anonymousSession } from '../../app/api/session/route';
import {
  GET as products,
  POST as capture,
  OPTIONS as productPreflight,
} from '../../app/api/products/route';
import { GET as productGet, DELETE as productDelete } from '../../app/api/products/[id]/route';
import { GET as productHistory } from '../../app/api/products/[id]/analysis-history/route';
import { GET as history } from '../../app/api/history/route';
import { POST as analyze } from '../../app/api/analyze-product/route';
import { GET as usage } from '../../app/api/analysis-usage/route';
import { GET as jobs, POST as enqueueJob } from '../../app/api/jobs/route';
import { GET as jobGet } from '../../app/api/jobs/[id]/route';
import { runAIJob } from './job-worker';
import { POST as code } from '../../app/api/bridge/code/route';
import { POST as pair } from '../../app/api/bridge/pair/route';
import { GET as bridgeStatus } from '../../app/api/bridge/status/route';
import { POST as revoke } from '../../app/api/bridge/revoke/route';
import { GET as backupGet, POST as backupPost } from '../../app/api/workspace-backup/route';
import { POST as libraryImport } from '../../app/api/library/import/route';

const origin = 'http://127.0.0.1:3000';
const extension = `chrome-extension://${'a'.repeat(32)}`;
const otherExtension = `chrome-extension://${'b'.repeat(32)}`;
const initialPassword = 'Synthetic-api-password-2026';
const draft = {
  source: 'amazon' as const,
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Synthetic route fixture',
  images: [],
  videos: [],
  bulletPoints: [],
};
type Handler = (request: Request) => Promise<Response>;
interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}
interface Account {
  user: User;
  cookie: string;
}
let directory: string;
let alice: Account, bob: Account, passwordUser: Account, capacityUser: Account;
let raceUser: Account;
const createdAccounts: Account[] = [];
const runId = randomUUID();
function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  headers: Record<string, string> = {},
): Request {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      host: '127.0.0.1:3000',
      origin,
      'sec-fetch-site': 'same-origin',
      'x-productspy-client': 'web',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function call(
  handler: Handler,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  headers: Record<string, string> = {},
) {
  return handler(request(path, method, body, cookie, headers));
}
async function data<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as ApiResult<T>;
  if (!envelope.ok) throw new Error(`${response.status}: ${envelope.error}`);
  return envelope.data;
}
async function newAccount(label: string): Promise<Account> {
  const response = await call(register, '/api/auth/register', 'POST', {
    email: `${label}-${runId}@example.invalid`,
    password: initialPassword,
    name: label,
  });
  expect(response.status).toBe(200);
  const account = {
    user: (await data<{ user: User }>(response)).user,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
  };
  createdAccounts.push(account);
  return account;
}
function extensionHeaders(token: string, selectedOrigin = extension): Record<string, string> {
  return {
    origin: selectedOrigin,
    'sec-fetch-site': 'none',
    'x-productspy-client': 'extension',
    authorization: `Bearer ${token}`,
  };
}
async function authorize(account: Account): Promise<string> {
  const authorization = await data<{ code: string }>(
    await call(code, '/api/bridge/code', 'POST', { extensionOrigin: extension }, account.cookie),
  );
  return (
    await data<{ token: string }>(
      await call(
        pair,
        '/api/bridge/pair',
        'POST',
        { code: authorization.code },
        '',
        extensionHeaders(''),
      ),
    )
  ).token;
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'productspy-route-postgres-'));
  vi.stubEnv('PRODUCTSPY_MODE', 'saas');
  if (process.env.PRODUCTSPY_TEST_DATABASE_URL) {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pg');
    vi.stubEnv('DATABASE_URL', process.env.PRODUCTSPY_TEST_DATABASE_URL);
    vi.stubEnv('PRODUCTSPY_AUTO_MIGRATE', process.env.PRODUCTSPY_TEST_AUTO_MIGRATE ?? '0');
  } else {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pglite');
    vi.stubEnv('PRODUCTSPY_PGLITE_DIR', join(directory, 'database'));
  }
  vi.stubEnv('PRODUCTSPY_APP_URL', origin);
  vi.stubEnv('AI_MODE', 'mock');
  vi.stubEnv('PRODUCTSPY_JOB_RUNNER', 'external');
  await ensureDatabase();
  alice = await newAccount('alice');
  bob = await newAccount('bob');
  passwordUser = await newAccount('password');
  capacityUser = await newAccount('capacity');
  raceUser = await newAccount('race');
}, 30000);
afterAll(async () => {
  if (createdAccounts.length)
    await query('DELETE FROM users WHERE id=ANY($1::text[])', [
      createdAccounts.map((account) => account.user.id),
    ]);
  await closeDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('SaaS real route handlers with PostgreSQL', () => {
  it('registers hashed credentials, sets protected cookies, rejects duplicate accounts and never creates anonymous sessions', async () => {
    const row = (
      await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [
        alice.user.id,
      ])
    ).rows[0];
    expect(row.password_hash).toMatch(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(row.password_hash).not.toContain(initialPassword);
    expect(
      (
        await call(register, '/api/auth/register', 'POST', {
          email: alice.user.email,
          password: initialPassword,
        })
      ).status,
    ).toBe(409);
    expect((await call(anonymousSession, '/api/session', 'POST', {})).status).toBe(401);
    expect((await call(me, '/api/auth/me')).status).toBe(401);
    expect(
      (
        await call(
          products,
          '/api/products',
          'GET',
          undefined,
          `productspy_session=${'a'.repeat(64)}`,
        )
      ).status,
    ).toBe(401);
  });
  it('authenticates durable sessions, rejects bad passwords, and revokes only the signed-out browser session', async () => {
    expect(
      (
        await call(login, '/api/auth/login', 'POST', {
          email: alice.user.email,
          password: 'Wrong-password-2026',
        })
      ).status,
    ).toBe(401);
    const response = await call(login, '/api/auth/login', 'POST', {
      email: alice.user.email,
      password: initialPassword,
    });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect((await call(me, '/api/auth/me', 'GET', undefined, cookie)).status).toBe(200);
    expect((await call(logout, '/api/auth/logout', 'POST', {}, cookie)).status).toBe(200);
    expect((await call(me, '/api/auth/me', 'GET', undefined, cookie)).status).toBe(401);
    expect((await call(me, '/api/auth/me', 'GET', undefined, alice.cookie)).status).toBe(200);
    await closeDatabase();
    await ensureDatabase();
    expect((await call(me, '/api/auth/me', 'GET', undefined, alice.cookie)).status).toBe(200);
  }, 30000);
  it('rejects hostile origins, forged hosts, cross-site reads and cookie-to-bearer substitution', async () => {
    expect(
      (
        await call(capture, '/api/products', 'POST', draft, alice.cookie, {
          origin: 'https://attacker.invalid',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(capture, '/api/products', 'POST', draft, alice.cookie, {
          host: 'attacker.invalid',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(capture, '/api/products', 'POST', draft, alice.cookie, { origin: '' })).status,
    ).toBe(403);
    expect(
      (
        await call(products, '/api/products', 'GET', undefined, alice.cookie, {
          'sec-fetch-site': 'cross-site',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(products, '/api/products', 'GET', undefined, '', {
          authorization: `Bearer ${alice.cookie.split('=')[1]}`,
        })
      ).status,
    ).toBe(403);
  });
  it('isolates list, detail, analysis history and deletes for users sharing an ASIN', async () => {
    const first = await data<Product>(
      await call(capture, '/api/products', 'POST', draft, alice.cookie),
    );
    expect(
      (
        await productGet(
          request(`/api/products/${first.id}`, 'GET', undefined, bob.cookie),
          context(first.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await productHistory(
          request(`/api/products/${first.id}/analysis-history`, 'GET', undefined, bob.cookie),
          context(first.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await productDelete(
          request(`/api/products/${first.id}`, 'DELETE', {}, bob.cookie),
          context(first.id),
        )
      ).status,
    ).toBe(404);
    await data<Product>(
      await call(
        capture,
        '/api/products',
        'POST',
        { ...draft, title: 'Bob private title' },
        bob.cookie,
      ),
    );
    expect(
      (
        await data<Product[]>(await call(products, '/api/products', 'GET', undefined, alice.cookie))
      )[0].title,
    ).toBe(draft.title);
    expect(
      (
        await data<Product[]>(await call(products, '/api/products', 'GET', undefined, bob.cookie))
      )[0].title,
    ).toBe('Bob private title');
    expect(
      (
        await productDelete(
          request(`/api/products/${first.id}`, 'DELETE', {}, bob.cookie),
          context(first.id),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await productGet(
          request(`/api/products/${first.id}`, 'GET', undefined, alice.cookie),
          context(first.id),
        )
      ).status,
    ).toBe(200);
  });
  it('replays capture requests without mutation and rejects idempotency-key payload conflicts', async () => {
    const key = randomUUID();
    const first = await data<Product>(
      await call(capture, '/api/products', 'POST', draft, alice.cookie, { 'idempotency-key': key }),
    );
    const replay = await data<Product>(
      await call(capture, '/api/products', 'POST', draft, alice.cookie, { 'idempotency-key': key }),
    );
    expect(replay.updatedAt).toBe(first.updatedAt);
    expect(
      (
        await call(
          capture,
          '/api/products',
          'POST',
          { ...draft, title: 'Conflicting payload' },
          alice.cookie,
          { 'idempotency-key': key },
        )
      ).status,
    ).toBe(409);
    expect(
      await withTenant(
        alice.user.id,
        async () =>
          (
            await query<{ count: number }>(
              'SELECT count(*)::int AS count FROM capture_events WHERE user_id=$1 AND id=$2',
              [alice.user.id, key],
            )
          ).rows[0].count,
      ),
    ).toBe(1);
  });
  it('runs the mock AI route, saves results and exposes only the owning usage and jobs', async () => {
    const product = await data<Product>(
      await call(capture, '/api/products', 'POST', draft, alice.cookie),
    );
    const result = await data<{ product: Product }>(
      await call(
        analyze,
        '/api/analyze-product',
        'POST',
        { product, options: DEFAULT_ANALYSIS_OPTIONS, requestId: randomUUID() },
        alice.cookie,
      ),
    );
    expect(result.product.aiAnalysis?.hooks.length).toBeGreaterThanOrEqual(5);
    expect(
      (
        await data<{ records: unknown[] }>(
          await call(usage, '/api/analysis-usage', 'GET', undefined, alice.cookie),
        )
      ).records,
    ).toHaveLength(1);
    expect(
      (
        await data<{ records: unknown[] }>(
          await call(usage, '/api/analysis-usage', 'GET', undefined, bob.cookie),
        )
      ).records,
    ).toHaveLength(0);
    expect(
      (
        await data<{ jobs: { status: string }[] }>(
          await call(jobs, '/api/jobs', 'GET', undefined, alice.cookie),
        )
      ).jobs[0].status,
    ).toBe('succeeded');
    expect(
      (await data<{ jobs: unknown[] }>(await call(jobs, '/api/jobs', 'GET', undefined, bob.cookie)))
        .jobs,
    ).toHaveLength(0);
    expect(
      (
        await call(
          history,
          `/api/history?kind=product&id=${encodeURIComponent(product.id)}`,
          'GET',
          undefined,
          bob.cookie,
        )
      ).status,
    ).toBe(404);
  });
  it('binds single-use extension authorization codes to the chosen extension origin', async () => {
    const authorization = await data<{ code: string }>(
      await call(code, '/api/bridge/code', 'POST', { extensionOrigin: extension }, alice.cookie),
    );
    expect(
      (
        await call(
          pair,
          '/api/bridge/pair',
          'POST',
          { code: authorization.code },
          '',
          extensionHeaders('', otherExtension),
        )
      ).status,
    ).toBe(401);
    const paired = await data<{ token: string; user: User }>(
      await call(
        pair,
        '/api/bridge/pair',
        'POST',
        { code: authorization.code },
        '',
        extensionHeaders(''),
      ),
    );
    expect(paired.user.id).toBe(alice.user.id);
    expect(
      (
        await call(
          pair,
          '/api/bridge/pair',
          'POST',
          { code: authorization.code },
          '',
          extensionHeaders(''),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          bridgeStatus,
          '/api/bridge/status',
          'GET',
          undefined,
          '',
          extensionHeaders(paired.token),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          bridgeStatus,
          '/api/bridge/status',
          'GET',
          undefined,
          '',
          extensionHeaders(paired.token, otherExtension),
        )
      ).status,
    ).toBe(403);
  });
  it('limits extension bearer sessions to capture and connection management, including preflight', async () => {
    const token = await authorize(alice);
    const headers = extensionHeaders(token);
    expect((await call(capture, '/api/products', 'POST', draft, '', headers)).status).toBe(200);
    for (const [handler, path] of [
      [products, '/api/products'],
      [backupGet, '/api/workspace-backup'],
      [usage, '/api/analysis-usage'],
      [me, '/api/auth/me'],
      [jobs, '/api/jobs'],
    ] as const)
      expect((await call(handler, path, 'GET', undefined, '', headers)).status).toBe(403);
    const preflight = await call(productPreflight, '/api/products', 'OPTIONS', undefined, '', {
      ...headers,
      'access-control-request-method': 'POST',
      'access-control-request-headers':
        'content-type,authorization,idempotency-key,x-productspy-client',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(extension);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
    expect((await call(logout, '/api/auth/logout', 'POST', {}, '', headers)).status).toBe(200);
    expect((await call(capture, '/api/products', 'POST', draft, '', headers)).status).toBe(401);
  });
  it('revokes connected extension tokens and outstanding codes without signing out the web user', async () => {
    const token = await authorize(alice);
    const authorization = await data<{ code: string }>(
      await call(code, '/api/bridge/code', 'POST', { extensionOrigin: extension }, alice.cookie),
    );
    expect((await call(revoke, '/api/bridge/revoke', 'POST', {}, alice.cookie)).status).toBe(200);
    expect(
      (await call(capture, '/api/products', 'POST', draft, '', extensionHeaders(token))).status,
    ).toBe(401);
    expect(
      (
        await call(
          pair,
          '/api/bridge/pair',
          'POST',
          { code: authorization.code },
          '',
          extensionHeaders(''),
        )
      ).status,
    ).toBe(401);
    expect((await call(me, '/api/auth/me', 'GET', undefined, alice.cookie)).status).toBe(200);
  });
  it('exports and restores only account-owned documents and preserves arbitrary legacy product IDs for capture retry', async () => {
    const backup = await data<WorkspaceBackup>(
      await call(backupGet, '/api/workspace-backup', 'GET', undefined, alice.cookie),
    );
    const bobBackup = await data<WorkspaceBackup>(
      await call(backupGet, '/api/workspace-backup', 'GET', undefined, bob.cookie),
    );
    expect(backup.library.products.length).toBeGreaterThan(0);
    expect(bobBackup.library.products).toHaveLength(0);
    expect(bobBackup.usage).toHaveLength(0);
    const legacyId = randomUUID(),
      stamp = new Date().toISOString();
    const legacy: WorkspaceBackup = {
      ...bobBackup,
      library: {
        products: [{ ...draft, id: legacyId, createdAt: stamp, updatedAt: stamp }],
        groups: [],
        tags: [],
      },
    };
    const preview = await data<{ preview: { revision: string } }>(
      await call(backupPost, '/api/workspace-backup', 'POST', { backup: legacy }, bob.cookie),
    );
    expect(
      (
        await call(
          backupPost,
          '/api/workspace-backup',
          'POST',
          {
            backup: legacy,
            commit: true,
            confirmed: true,
            policy: 'skip',
            expectedRevision: preview.preview.revision,
          },
          bob.cookie,
        )
      ).status,
    ).toBe(200);
    const key = randomUUID();
    expect(
      (
        await data<Product>(
          await call(capture, '/api/products', 'POST', draft, bob.cookie, {
            'idempotency-key': key,
          }),
        )
      ).id,
    ).toBe(legacyId);
    expect(
      (await call(capture, '/api/products', 'POST', draft, bob.cookie, { 'idempotency-key': key }))
        .status,
    ).toBe(200);
  });
  it('cannot bypass Free product capacity through either library import or full backup restore', async () => {
    const current = await data<WorkspaceBackup>(
      await call(backupGet, '/api/workspace-backup', 'GET', undefined, capacityUser.cookie),
    );
    const stamp = new Date().toISOString();
    const tooMany = Array.from({ length: 51 }, (_, index) => {
      const asin = `B${String(index).padStart(9, '0')}`;
      return {
        ...draft,
        id: `amazon:${asin}`,
        sourceId: asin,
        url: `https://www.amazon.com/dp/${asin}`,
        createdAt: stamp,
        updatedAt: stamp,
      };
    });
    const incoming = { ...current, library: { products: tooMany, groups: [], tags: [] } };
    const library = {
      format: 'productspy-library',
      schemaVersion: 1,
      exportedAt: stamp,
      ...incoming.library,
    };
    const libraryPreview = await data<{ revision: string }>(
      await call(
        libraryImport,
        '/api/library/import',
        'POST',
        { action: 'preview', data: library },
        capacityUser.cookie,
      ),
    );
    expect(
      (
        await call(
          libraryImport,
          '/api/library/import',
          'POST',
          {
            action: 'commit',
            data: library,
            policy: 'skip',
            confirmed: true,
            expectedRevision: libraryPreview.revision,
          },
          capacityUser.cookie,
        )
      ).status,
    ).toBe(403);
    const preview = await data<{ preview: { revision: string } }>(
      await call(
        backupPost,
        '/api/workspace-backup',
        'POST',
        { backup: incoming },
        capacityUser.cookie,
      ),
    );
    const restored = await call(
      backupPost,
      '/api/workspace-backup',
      'POST',
      {
        backup: incoming,
        commit: true,
        confirmed: true,
        policy: 'skip',
        expectedRevision: preview.preview.revision,
      },
      capacityUser.cookie,
    );
    expect(restored.status).toBe(403);
    expect(
      await data<Product[]>(
        await call(products, '/api/products', 'GET', undefined, capacityUser.cookie),
      ),
    ).toEqual([]);
  });
  it('revokes every browser, extension and pending authorization code when the password changes', async () => {
    const token = await authorize(passwordUser);
    const pending = await data<{ code: string }>(
      await call(
        code,
        '/api/bridge/code',
        'POST',
        { extensionOrigin: extension },
        passwordUser.cookie,
      ),
    );
    const second = await call(login, '/api/auth/login', 'POST', {
      email: passwordUser.user.email,
      password: initialPassword,
    });
    const secondCookie = second.headers.get('set-cookie')!.split(';')[0];
    const nextPassword = 'New-synthetic-password-2026';
    expect(
      (
        await call(
          password,
          '/api/auth/password',
          'POST',
          { currentPassword: initialPassword, password: nextPassword },
          passwordUser.cookie,
        )
      ).status,
    ).toBe(200);
    for (const cookie of [passwordUser.cookie, secondCookie])
      expect((await call(me, '/api/auth/me', 'GET', undefined, cookie)).status).toBe(401);
    expect(
      (await call(capture, '/api/products', 'POST', draft, '', extensionHeaders(token))).status,
    ).toBe(401);
    expect(
      (
        await call(
          pair,
          '/api/bridge/pair',
          'POST',
          { code: pending.code },
          '',
          extensionHeaders(''),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(login, '/api/auth/login', 'POST', {
          email: passwordUser.user.email,
          password: initialPassword,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(login, '/api/auth/login', 'POST', {
          email: passwordUser.user.email,
          password: nextPassword,
        })
      ).status,
    ).toBe(200);
  });
  it('rejects a request authenticated before concurrent password revocation but resumed afterward', async () => {
    const original = security.authenticateAccount;
    let authenticated!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      authenticated = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    // Delay only scheduling after the real database authentication; never fabricate an identity.
    const spy = vi
      .spyOn(security, 'authenticateAccount')
      .mockImplementation(async (req, webOnly) => {
        const identity = await original(req, webOnly);
        if (
          first &&
          new URL(req.url).pathname === '/api/products' &&
          identity.user.id === raceUser.user.id
        ) {
          first = false;
          authenticated();
          await resume;
        }
        return identity;
      });
    const pending = call(capture, '/api/products', 'POST', draft, raceUser.cookie);
    await ready;
    try {
      expect(
        (
          await call(
            password,
            '/api/auth/password',
            'POST',
            { currentPassword: initialPassword, password: 'Race-updated-password-2026' },
            raceUser.cookie,
          )
        ).status,
      ).toBe(200);
    } finally {
      release();
    }
    const response = await pending;
    spy.mockRestore();
    expect(response.status).toBe(401);
    expect(
      await withTenant(
        raceUser.user.id,
        async () =>
          (
            await query<{ count: number }>(
              'SELECT count(*)::int AS count FROM workspace_documents WHERE user_id=$1',
              [raceUser.user.id],
            )
          ).rows[0].count,
      ),
    ).toBe(0);
  });
  it('persists queued AI jobs, reserves quota once, deduplicates and isolates results', async () => {
    const owner = await newAccount('queued-worker');
    const product = await data<Product>(
      await call(capture, '/api/products', 'POST', draft, owner.cookie),
    );
    const id = randomUUID();
    const input = {
      endpoint: '/api/analyze-product',
      input: { product, requestId: id, options: DEFAULT_ANALYSIS_OPTIONS },
    };
    const queued = await call(enqueueJob, '/api/jobs', 'POST', input, owner.cookie);
    expect(queued.status).toBe(202);
    expect(
      await data(await call(enqueueJob, '/api/jobs', 'POST', input, owner.cookie)),
    ).toMatchObject({ id, replayed: true });
    expect(
      (
        await call(
          enqueueJob,
          '/api/jobs',
          'POST',
          {
            ...input,
            input: {
              ...input.input,
              options: { ...DEFAULT_ANALYSIS_OPTIONS, customInstructions: 'changed' },
            },
          },
          owner.cookie,
        )
      ).status,
    ).toBe(409);
    expect(
      (await jobGet(request(`/api/jobs/${id}`, 'GET', undefined, bob.cookie), context(id))).status,
    ).toBe(404);
    expect(
      (
        await data<{ usage: { ai: number } }>(
          await call(me, '/api/auth/me', 'GET', undefined, owner.cookie),
        )
      ).usage.ai,
    ).toBe(1);
    expect(await runAIJob(owner.user.id, id)).toBe(true);
    expect(await runAIJob(owner.user.id, id)).toBe(false);
    const completed = await data<{
      status: string;
      result: { status: number; body: { data: { product: Product } } };
    }>(await jobGet(request(`/api/jobs/${id}`, 'GET', undefined, owner.cookie), context(id)));
    expect(completed.status).toBe('succeeded');
    expect(completed.result.status).toBe(200);
    expect(completed.result.body.data.product.aiAnalysis).toBeTruthy();
    expect(
      (
        await data<{ usage: { ai: number } }>(
          await call(me, '/api/auth/me', 'GET', undefined, owner.cookie),
        )
      ).usage.ai,
    ).toBe(1);
  });
  it.skipIf(!process.env.PRODUCTSPY_TEST_DATABASE_URL)(
    'runs a persisted PostgreSQL job in an independent Node worker process after the creating request ends',
    async () => {
      const owner = await newAccount('process-worker');
      const product = await data<Product>(
        await call(capture, '/api/products', 'POST', draft, owner.cookie),
      );
      const id = randomUUID();
      expect(
        (
          await call(
            enqueueJob,
            '/api/jobs',
            'POST',
            {
              endpoint: '/api/analyze-product',
              input: { product, requestId: id, options: DEFAULT_ANALYSIS_OPTIONS },
            },
            owner.cookie,
          )
        ).status,
      ).toBe(202);
      const output = await promisify(execFile)(
        process.execPath,
        [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), 'scripts/saas/worker.ts', '--once'],
        {
          cwd: process.cwd(),
          windowsHide: true,
          timeout: 30000,
          env: {
            ...process.env,
            PRODUCTSPY_MODE: 'saas',
            PRODUCTSPY_DB_DRIVER: 'pg',
            DATABASE_URL: process.env.PRODUCTSPY_TEST_DATABASE_URL,
            PRODUCTSPY_AUTO_MIGRATE: '0',
            PRODUCTSPY_ENV: 'test',
            PRODUCTSPY_APP_URL: origin,
            AI_MODE: 'mock',
          },
        },
      );
      expect(output.stdout).toContain('Processed 1 queued tasks.');
      const completed = await data<{ status: string }>(
        await jobGet(request(`/api/jobs/${id}`, 'GET', undefined, owner.cookie), context(id)),
      );
      expect(completed.status).toBe('succeeded');
    },
    30000,
  );
  it.skipIf(!process.env.PRODUCTSPY_TEST_DATABASE_URL)(
    'runs the legacy import CLI in preview and commit modes without changing its source backup',
    async () => {
      const sourceOwner = await newAccount('import-source'),
        targetOwner = await newAccount('import-target');
      expect((await call(capture, '/api/products', 'POST', draft, sourceOwner.cookie)).status).toBe(
        200,
      );
      const backup = await data<WorkspaceBackup>(
        await call(backupGet, '/api/workspace-backup', 'GET', undefined, sourceOwner.cookie),
      );
      const source = JSON.stringify(backup),
        file = join(directory, 'synthetic-legacy-backup.json');
      await writeFile(file, source);
      const run = (commit: boolean) =>
        promisify(execFile)(
          process.execPath,
          [
            join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
            'scripts/saas/import-legacy.ts',
            file,
            targetOwner.user.id,
            ...(commit ? ['--commit'] : []),
          ],
          {
            cwd: process.cwd(),
            windowsHide: true,
            timeout: 30000,
            env: {
              ...process.env,
              PRODUCTSPY_MODE: 'saas',
              PRODUCTSPY_DB_DRIVER: 'pg',
              DATABASE_URL: process.env.PRODUCTSPY_TEST_DATABASE_URL,
              PRODUCTSPY_AUTO_MIGRATE: '0',
            },
          },
        );
      const preview = await run(false);
      expect(preview.stdout).toContain('sourceSha256');
      expect(
        await data(await call(products, '/api/products', 'GET', undefined, targetOwner.cookie)),
      ).toEqual([]);
      expect((await run(true)).stdout).toContain('"committed":true');
      expect(
        await data<Product[]>(
          await call(products, '/api/products', 'GET', undefined, targetOwner.cookie),
        ),
      ).toHaveLength(1);
      expect(
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ).toBe(createHash('sha256').update(source).digest('hex'));
    },
    30000,
  );
  it.skipIf(!process.env.PRODUCTSPY_TEST_DATABASE_URL)(
    'allows PostgreSQL tenant reads during AI-style mutation locks while preserving write serialization and RLS connection cleanup',
    async () => {
      let release!: () => void, entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = withTenant(alice.user.id, async () => {
        await query('SELECT 1');
        entered();
        await done;
      });
      await ready;
      let secondEntered = false;
      const second = withTenant(alice.user.id, async () => {
        secondEntered = true;
      });
      try {
        const result = await withTenantRead(alice.user.id, async () => {
          const setting = await query<{ user_id: string }>(
            "SELECT current_setting('app.user_id',true) AS user_id",
          );
          const visible = await query<{ user_id: string }>(
            'SELECT user_id FROM workspace_documents',
          );
          return { setting, visible };
        });
        expect(result.setting.rows[0].user_id).toBe(alice.user.id);
        expect(result.visible.rows.length).toBeGreaterThan(0);
        expect(result.visible.rows.every((row) => row.user_id === alice.user.id)).toBe(true);
        const lock = await dbTransaction(async () => {
          const checked = await query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
            [`productspy:${alice.user.id}`],
          );
          if (checked.rows[0].locked)
            await query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
              `productspy:${alice.user.id}`,
            ]);
          return checked.rows[0].locked;
        });
        expect(lock).toBe(false);
        expect(secondEntered).toBe(false);
      } finally {
        release();
        await Promise.all([writer, second]);
      }
      expect(secondEntered).toBe(true);
      const reused = await Promise.all(
        Array.from({ length: 12 }, () =>
          query<{ scope: string | null }>("SELECT current_setting('app.user_id',true) AS scope"),
        ),
      );
      expect(reused.every((result) => !result.rows[0].scope)).toBe(true);
    },
  );
});
