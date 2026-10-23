import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const account = (id = 'alice') => ({
  user: { id, name: id, email: `${id}@example.test`, createdAt: '2026-10-17T00:00:00Z' },
  subscription: { plan: 'free', status: 'active' },
  usage: { products: 1, ai: 1 },
  limits: { products: 50, ai: 10 },
});
const success = (data: unknown) => Response.json({ ok: true, data });
const completed = () =>
  success({ status: 'succeeded', result: { status: 200, body: { ok: true, data: 'saved' } } });
const limited = (retryAfter?: string) =>
  Response.json(
    { ok: false, error: 'Rate limited' },
    { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} },
  );
const generation = (signal?: AbortSignal) => ({
  method: 'POST',
  body: JSON.stringify({ requestId: 'same-request', product: { id: 'private-product' } }),
  signal,
});

describe('SaaS accepted AI job polling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_PRODUCTSPY_MODE', 'saas');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(['seconds', 'date', 'non-json'] as const)(
    'waits for %s Retry-After on a limited GET, then reads the same job without submitting AI again',
    async (kind) => {
      let reads = 0;
      const header = kind === 'date' ? new Date(Date.now() + 30_000).toUTCString() : '30';
      const fetch = vi.fn(async (path: string, _init?: RequestInit) => {
        if (path === '/api/session') return success(account());
        if (path === '/api/jobs') return success({ id: 'accepted-job' });
        reads += 1;
        if (reads > 1) return completed();
        return kind === 'non-json'
          ? new Response('Rate limited', { status: 429, headers: { 'Retry-After': header } })
          : limited(header);
      });
      vi.stubGlobal('fetch', fetch);
      const { webRequest } = await import('./session');
      const pending = webRequest('/api/analyze-product', generation());
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe('saved');
      expect(fetch.mock.calls.map(([path]) => path)).toEqual([
        '/api/session',
        '/api/jobs',
        '/api/jobs/accepted-job',
        '/api/jobs/accepted-job',
      ]);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    },
  );

  it('backs off a finite number of times when Retry-After is absent or malformed', async () => {
    let reads = 0;
    const fetch = vi.fn(async (path: string) => {
      if (path === '/api/session') return success(account());
      if (path === '/api/jobs') return success({ id: 'accepted-job' });
      reads += 1;
      return limited(reads % 2 ? undefined : 'invalid');
    });
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    const pending = webRequest('/api/analyze-product', generation());
    const rejected = expect(pending).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(72_000);
    await rejected;
    expect(reads).toBe(6);
    expect(fetch.mock.calls.filter(([path]) => path === '/api/jobs')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(reads).toBe(6);
  });

  it('bounds a long server cooldown by the overall deadline without polling early or resubmitting', async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === '/api/session') return success(account());
      return path === '/api/jobs' ? success({ id: 'accepted-job' }) : limited('3600');
    });
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    const pending = webRequest('/api/analyze-product', generation());
    const rejected = expect(pending).rejects.toThrow('任务仍在服务端处理');
    await vi.advanceTimersByTimeAsync(299_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('cancels a cooldown immediately without deleting or submitting the server task', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (path: string) => {
      if (path === '/api/session') return success(account());
      return path === '/api/jobs' ? success({ id: 'accepted-job' }) : limited('60');
    });
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    const pending = webRequest('/api/analyze-product', generation(controller.signal));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['cooldown', 'request'] as const)(
    'stops the previous account during a pending %s and preserves the new account',
    async (stage) => {
      let current = 'alice';
      let pollSignal: AbortSignal | undefined;
      const fetch = vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/api/session') return success(account(current));
        if (path === '/api/jobs') return success({ id: 'alice-private-job' });
        if (stage === 'cooldown') return limited('60');
        pollSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          pollSignal?.addEventListener('abort', () => reject(pollSignal?.reason), { once: true });
        });
      });
      vi.stubGlobal('fetch', fetch);
      const { webRequest, clearAccountSession, refreshAccountSession, getAccountSession } =
        await import('./session');
      const pending = webRequest('/api/analyze-product', generation());
      const rejected = expect(pending).rejects.toMatchObject({ status: 401 });
      await vi.advanceTimersByTimeAsync(0);
      clearAccountSession();
      current = 'bob';
      await refreshAccountSession();
      await rejected;
      if (stage === 'request') expect(pollSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getAccountSession()?.user.id).toBe('bob');
      expect(fetch.mock.calls.map(([path]) => path)).toEqual([
        '/api/session',
        '/api/jobs',
        '/api/jobs/alice-private-job',
        '/api/session',
      ]);
    },
  );

  it('does not retry a limited submission or a completed task whose AI result is 429', async () => {
    const fetch = vi.fn(async (path: string) =>
      path === '/api/session' ? success(account()) : limited('1'),
    );
    vi.stubGlobal('fetch', fetch);
    const { webRequest } = await import('./session');
    await expect(webRequest('/api/analyze-product', generation())).rejects.toMatchObject({
      status: 429,
    });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/jobs']);
    fetch.mockImplementation(async (path: string) =>
      path === '/api/jobs'
        ? success({ id: 'completed-job' })
        : success({
            status: 'failed',
            result: { status: 429, body: { ok: false, error: 'AI provider limited' } },
          }),
    );
    await expect(webRequest('/api/analyze-product', generation())).rejects.toMatchObject({
      status: 429,
      message: 'AI provider limited',
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/session',
      '/api/jobs',
      '/api/jobs',
      '/api/jobs/completed-job',
    ]);
  });
});
