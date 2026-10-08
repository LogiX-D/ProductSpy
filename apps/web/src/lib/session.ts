import { ApiRequestError, apiRequest } from '@productspy/shared';

let session: Promise<void> | undefined;

export function ensureSession(): Promise<void> {
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

// A 401 is emitted before any business operation, so exactly one renewed-session retry is safe.
export async function webRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestSession = ensureSession();
  await requestSession;
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
  const headers = new Headers(init.headers);
  headers.set('X-ProductSpy-Client', 'web');
  const request = () => fetch(path, { ...init, headers, credentials: 'same-origin' });
  const response = await request();
  if (response.status !== 401) return response;
  await response.body?.cancel();
  if (session === requestSession) session = undefined;
  await ensureSession();
  return request();
}
