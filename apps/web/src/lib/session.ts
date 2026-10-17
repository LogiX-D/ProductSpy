import { ApiRequestError, apiRequest } from '@productspy/shared';
import type { AccountSession } from './saas-types';

export const isLegacyMode = process.env.NEXT_PUBLIC_PRODUCTSPY_MODE === 'legacy';
export const ACCOUNT_CHANGED_EVENT = 'productspy:account-changed';
export const ACCOUNT_STORAGE_EVENT = 'productspy:account-change';

let session: Promise<void> | undefined;
let account: AccountSession | undefined;
let accountRequest: Promise<AccountSession> | undefined;
let accountRevision = 0;

function clearPrivateDrafts(): void {
  if (typeof window === 'undefined') return;
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith('productspy:')) window.sessionStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable independently in restricted browsers.
  }
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('productspy:') && key !== ACCOUNT_STORAGE_EVENT)
        window.localStorage.removeItem(key);
    }
  } catch {
    // SaaS business records are never cached in IndexedDB.
  }
}

function adoptDraftIdentity(userId: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (sessionStorage.getItem('productspy:draft-owner') !== userId) clearPrivateDrafts();
    sessionStorage.setItem('productspy:draft-owner', userId);
  } catch {
    clearPrivateDrafts();
  }
}

function notifyAccountChange(broadcast = false): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
  if (broadcast) {
    try {
      localStorage.setItem(ACCOUNT_STORAGE_EVENT, `${Date.now()}:${Math.random()}`);
    } catch {
      // Focus/session checks still verify the server cookie when storage is unavailable.
    }
  }
}

export function getAccountSession(): AccountSession | undefined {
  return account;
}

/** Invalidate pending responses as well as private drafts when identity changes. */
export function clearAccountSession(broadcast = false): void {
  accountRevision += 1;
  account = undefined;
  accountRequest = undefined;
  clearPrivateDrafts();
  notifyAccountChange(broadcast);
}

export async function accountRequestRaw<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-ProductSpy-Client', 'web');
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: init.signal ?? AbortSignal.timeout(20000),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new Error('无法连接 ProductSpy，请检查网络后重试。');
    throw error;
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (body && typeof body === 'object' && 'ok' in body) {
    if (body.ok === true && response.ok && 'data' in body) return body.data as T;
    if ('error' in body && typeof body.error === 'string')
      throw new ApiRequestError(body.error, response.status);
  }
  throw new ApiRequestError(`ProductSpy 返回了无效响应 (${response.status})`, response.status);
}

export async function refreshAccountSession(force = false): Promise<AccountSession> {
  if (!force && account) return account;
  if (accountRequest) return accountRequest;
  const revision = accountRevision;
  const pending = accountRequestRaw<AccountSession>('/api/session')
    .then((next) => {
      if (revision !== accountRevision) throw new ApiRequestError('账号已切换，请重新加载。', 401);
      if (!next?.user?.id || !next.subscription || !next.limits || !next.usage)
        throw new Error('账号资料无效，请重新登录。');
      if (account?.user.id !== next.user.id) {
        adoptDraftIdentity(next.user.id);
        accountRevision += 1;
      }
      account = next;
      notifyAccountChange();
      return next;
    })
    .catch((error: unknown) => {
      if (error instanceof ApiRequestError && error.status === 401 && revision === accountRevision)
        clearAccountSession();
      throw error;
    })
    .finally(() => {
      if (accountRequest === pending) accountRequest = undefined;
    });
  accountRequest = pending;
  return pending;
}

export function ensureSession(): Promise<void> {
  if (!isLegacyMode) return refreshAccountSession().then(() => undefined);
  session ??= apiRequest('/api/session', {
    method: 'POST',
    body: '{}',
    credentials: 'same-origin',
  })
    .then(() => undefined)
    .catch((error: unknown) => {
      session = undefined;
      throw error;
    });
  return session;
}

// Legacy bootstrap retries only a 401 emitted before a business operation.
export async function webRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestSession = ensureSession();
  await requestSession;
  if (!isLegacyMode) {
    const revision = accountRevision;
    try {
      let data: T;
      if (
        init.method === 'POST' &&
        ['/api/analyze-product', '/api/analyze-comparison', '/api/generate-content'].includes(
          path,
        ) &&
        typeof init.body === 'string'
      ) {
        const job = await accountRequestRaw<{ id: string }>('/api/jobs', {
          ...init,
          body: JSON.stringify({ endpoint: path, input: JSON.parse(init.body) }),
        });
        const deadline = Date.now() + 150_000;
        for (;;) {
          if (revision !== accountRevision)
            throw new ApiRequestError('账号已切换，请重新加载。', 401);
          if (init.signal?.aborted)
            throw new DOMException('Request aborted; server task may continue', 'AbortError');
          const result = await accountRequestRaw<{
            status: string;
            error?: string;
            result?: { status: number; body: { ok: boolean; data: T; error?: string } };
          }>(`/api/jobs/${encodeURIComponent(job.id)}`);
          if (result.result) {
            if (!result.result.body.ok)
              throw new ApiRequestError(
                result.result.body.error ?? '后台任务失败',
                result.result.status,
              );
            data = result.result.body.data;
            break;
          }
          if (['failed', 'interrupted', 'succeeded'].includes(result.status))
            throw new Error(
              result.error ?? '任务已结束，请在任务和业务历史中检查已保存结果；不会自动重发',
            );
          if (Date.now() > deadline)
            throw new Error('任务仍在服务端处理，请稍后查看任务和已保存结果；不会自动重发');
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      } else data = await accountRequestRaw<T>(path, init);
      if (revision !== accountRevision) throw new ApiRequestError('账号已切换，请重新加载。', 401);
      return data;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401 && revision === accountRevision)
        clearAccountSession();
      throw error;
    }
  }
  try {
    return await apiRequest<T>(path, { ...init, credentials: 'same-origin' });
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
    if (session === requestSession) session = undefined;
    await ensureSession();
    return apiRequest<T>(path, { ...init, credentials: 'same-origin' });
  }
}

export async function webFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const requestSession = ensureSession();
  await requestSession;
  const revision = accountRevision;
  const headers = new Headers(init.headers);
  headers.set('X-ProductSpy-Client', 'web');
  const request = () =>
    fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  const response = await request();
  if (!isLegacyMode) {
    if (revision !== accountRevision || response.status === 401) {
      await response.body?.cancel();
      if (revision === accountRevision) clearAccountSession();
      throw new ApiRequestError('登录已过期或账号已切换，请重新登录。', 401);
    }
    return response;
  }
  if (response.status !== 401) return response;
  await response.body?.cancel();
  if (session === requestSession) session = undefined;
  await ensureSession();
  return request();
}
