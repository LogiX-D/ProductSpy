import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const success = (data: unknown) => Response.json({ ok: true, data });
const account = {
  user: {
    id: 'alice',
    name: 'Alice',
    email: 'alice@example.invalid',
    createdAt: '2026-10-18T00:00:00Z',
  },
  subscription: { plan: 'free', status: 'active' },
  usage: { products: 1, ai: 0 },
  limits: { products: 50, ai: 10 },
  billingEnabled: false,
};

describe('Task history reads combine cancellation with their network deadline', () => {
  let readSignal: AbortSignal | undefined;
  const transport = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/api/session') return success(account);
    readSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      if (readSignal?.aborted) reject(readSignal.reason);
      else readSignal?.addEventListener('abort', () => reject(readSignal?.reason), { once: true });
    });
  };
  const fetch = vi.fn(transport);
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv('NEXT_PUBLIC_PRODUCTSPY_MODE', 'saas');
    fetch.mockReset().mockImplementation(transport);
    readSignal = undefined;
    vi.stubGlobal('fetch', fetch);
    // Native AbortSignal.timeout uses Node's internal clock; bridge only that clock
    // to fake timers while exercising the real request/session/cancellation path.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const timer = new AbortController();
      setTimeout(
        () => timer.abort(new DOMException('Request timed out', 'TimeoutError')),
        milliseconds,
      );
      return timer.signal;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('times out a hanging fetch at 20 seconds despite a live caller signal, then allows a fresh read', async () => {
    const caller = new AbortController();
    const { getJobs } = await import('./saas-api');
    const { getAccountSession } = await import('./session');
    const pending = getJobs({ cursor: 'page-cursor', limit: 50, signal: caller.signal }).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(20_000);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/session',
      '/api/jobs?cursor=page-cursor&limit=50',
    ]);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(readSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    try {
      expect(readSignal?.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(false);
      expect(await pending).toMatchObject({ name: 'TimeoutError' });
    } finally {
      caller.abort();
    }
    expect(getAccountSession()?.user.id).toBe('alice');
    fetch.mockResolvedValueOnce(success({ jobs: [], nextCursor: null }));
    expect(await getJobs()).toEqual({ jobs: [], nextCursor: null });
    expect(fetch.mock.calls.filter(([path]) => path === '/api/session')).toHaveLength(1);
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('retains the normal 20-second deadline when no cancellation signal is supplied', async () => {
    const { getJobs } = await import('./saas-api');
    const pending = getJobs().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readSignal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ name: 'TimeoutError' });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/jobs']);
  });

  it('honors an explicit earlier cancellation without waiting for the deadline or retrying', async () => {
    const caller = new AbortController();
    const { getJobs } = await import('./saas-api');
    const pending = getJobs({ signal: caller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(750);
    expect(readSignal?.aborted).toBe(false);
    caller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(readSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves an already-cancelled caller reason instead of replacing it with a later timeout', async () => {
    const caller = new AbortController();
    const reason = new DOMException('Page was replaced', 'AbortError');
    caller.abort(reason);
    const { getJobs } = await import('./saas-api');
    expect(await getJobs({ signal: caller.signal }).catch((error: unknown) => error)).toBe(reason);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
