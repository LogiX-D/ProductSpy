import { createWebSession, SESSION_COOKIE } from './auth';

/** Test-only local sessions; fixtures never read real credentials or user products. */
export function webHeaders(origin = 'http://localhost:3000'): Record<string, string> {
  const headers = {
    origin,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-productspy-client': 'web',
  };
  const token = createWebSession(new Request(`${origin}/api/session`, { headers }));
  return { ...headers, cookie: `${SESSION_COOKIE}=${token}` };
}
