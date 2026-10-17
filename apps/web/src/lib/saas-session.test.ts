// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const account = (id: string) => ({
  user: { id, name: id, email: `${id}@example.test`, createdAt: '2026-10-17T00:00:00Z' },
  subscription: { plan: 'free' as const, status: 'active' },
  usage: { products: 1, ai: 0 },
  limits: { products: 50, ai: 10 },
  billingEnabled: false,
});
const success = (data: unknown) => Response.json({ ok: true, data });
const failure = (status: number) =>
  Response.json({ ok: false, error: 'Access rejected' }, { status });

describe('SaaS session and browser data isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_PRODUCTSPY_MODE', 'saas');
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads an existing account with GET and never creates an anonymous session', async () => {
    const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
      success(path === '/api/session' ? account('alice') : []),
    );
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    await webRequest('/api/products');
    await webRequest('/api/library');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/session',
      '/api/products',
      '/api/library',
    ]);
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('does not retry a rejected write or renew an anonymous session on 401', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(success(account('alice')))
      .mockResolvedValueOnce(failure(401));
    vi.stubGlobal('fetch', fetch);
    const { webRequest, getAccountSession } = await import('./session');
    await expect(webRequest('/api/products', { method: 'POST', body: '{}' })).rejects.toMatchObject(
      { status: 401 },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getAccountSession()).toBeUndefined();
  });

  it('discards a pending previous-account response without invalidating the new account', async () => {
    let current = 'alice';
    let release: ((response: Response) => void) | undefined;
    let sent: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const waiting = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === '/api/session') return success(account(current));
        sent?.();
        return waiting;
      }),
    );
    const { webRequest, clearAccountSession, refreshAccountSession, getAccountSession } =
      await import('./session');
    const pending = webRequest('/api/products');
    const rejection = expect(pending).rejects.toMatchObject({ status: 401 });
    await started;
    clearAccountSession();
    current = 'bob';
    await refreshAccountSession();
    release?.(success([{ title: 'Alice private product' }]));
    await rejection;
    expect(getAccountSession()?.user.id).toBe('bob');
  });

  it('clears private drafts and custom preferences when identity changes, but preserves same-user reload drafts', async () => {
    sessionStorage.setItem('productspy:draft-owner', 'alice');
    sessionStorage.setItem('productspy:analysis-draft:v1:amazon:ASIN', 'Alice private text');
    localStorage.setItem('productspy:content-preferences:v1', 'Alice custom requirements');
    let current = 'alice';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => success(account(current))),
    );
    const { refreshAccountSession } = await import('./session');
    await refreshAccountSession();
    expect(sessionStorage.getItem('productspy:analysis-draft:v1:amazon:ASIN')).toBe(
      'Alice private text',
    );
    current = 'bob';
    await refreshAccountSession(true);
    expect(sessionStorage.getItem('productspy:analysis-draft:v1:amazon:ASIN')).toBeNull();
    expect(localStorage.getItem('productspy:content-preferences:v1')).toBeNull();
    expect(sessionStorage.getItem('productspy:draft-owner')).toBe('bob');
  });

  it.each(['login', 'register'] as const)(
    'notifies another tab after %s changes the shared cookie, even if its earlier session check read the old account',
    async (kind) => {
      let cookieUser = 'alice';
      let completeAuthentication!: () => void;
      const authentication = new Promise<void>((resolve) => {
        completeAuthentication = resolve;
      });
      const fetch = vi.fn(async (path: string) => {
        if (path === `/api/auth/${kind}`) {
          await authentication;
          cookieUser = 'bob';
          return success({});
        }
        return success(account(cookieUser));
      });
      vi.stubGlobal('fetch', fetch);
      const otherTab = await import('./session');
      await otherTab.refreshAccountSession();
      vi.resetModules();
      const currentTab = await import('./saas-api');
      const checks: Promise<unknown>[] = [];
      const setItem = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key,
        value,
      ) {
        setItem.call(this, key, value);
        if (this === localStorage && key === otherTab.ACCOUNT_STORAGE_EVENT) {
          // Browser storage events reach the other document, not the writer.
          otherTab.clearAccountSession();
          checks.push(otherTab.refreshAccountSession(true));
        }
      });
      const input = { email: 'bob@example.test', password: 'synthetic-password', name: 'Bob' };
      const signingIn =
        kind === 'login' ? currentTab.signIn(input) : currentTab.registerAccount(input);
      await Promise.all(checks);
      expect(otherTab.getAccountSession()?.user.id).toBe('alice');
      completeAuthentication();
      await signingIn;
      await Promise.all(checks);
      expect(otherTab.getAccountSession()?.user.id).toBe('bob');
    },
  );

  it('invalidates an old-cookie session response still pending in another tab when login succeeds', async () => {
    let cookieUser = 'alice';
    let holdOldSession = false;
    let finishOldSession!: (value: Response) => void;
    let completeAuthentication!: () => void;
    const authentication = new Promise<void>((resolve) => {
      completeAuthentication = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === '/api/auth/login') {
          await authentication;
          cookieUser = 'bob';
          return success({});
        }
        if (cookieUser === 'alice' && holdOldSession)
          return new Promise<Response>((resolve) => {
            finishOldSession = resolve;
          });
        return success(account(cookieUser));
      }),
    );
    const otherTab = await import('./session');
    await otherTab.refreshAccountSession();
    vi.resetModules();
    const currentTab = await import('./saas-api');
    const checks: Promise<unknown>[] = [];
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      setItem.call(this, key, value);
      if (this === localStorage && key === otherTab.ACCOUNT_STORAGE_EVENT) {
        otherTab.clearAccountSession();
        // The component catches an obsolete verification rather than adopting it.
        checks.push(otherTab.refreshAccountSession(true).catch((error: unknown) => error));
      }
    });
    holdOldSession = true;
    const signingIn = currentTab.signIn({
      email: 'bob@example.test',
      password: 'synthetic-password',
    });
    completeAuthentication();
    await signingIn;
    finishOldSession(success(account('alice')));
    const results = await Promise.all(checks);
    expect(results.some((result) => result instanceof Error)).toBe(true);
    expect(otherTab.getAccountSession()?.user.id).toBe('bob');
  });

  it('never persists or returns a shared IndexedDB business cache in SaaS', async () => {
    const { webCache } = await import('./storage/web-storage');
    await webCache.replace([{ title: 'Do not cache' }] as never[]);
    expect(await webCache.list()).toEqual([]);
    expect(await webCache.get('amazon:ASIN')).toBeUndefined();
  });

  it.each([401, 403, 503])('does not fall back to a previous cache on HTTP %i', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(success(account('alice')))
        .mockResolvedValueOnce(failure(status)),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { webCache } = await import('./storage/web-storage');
    const cached = vi.spyOn(webCache, 'list');
    const { loadProducts } = await import('./storage/product-api');
    expect((await loadProducts()).products).toEqual([]);
    expect(cached).not.toHaveBeenCalled();
  });
});
