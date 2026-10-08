import {
  createWebSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from '../../../lib/server/auth';
import { readJsonBody, withApiRequest } from '../../../lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let token: string | undefined;
  const response = await withApiRequest(
    request,
    async () => {
      await readJsonBody(request);
      token = createWebSession(request);
      return { authenticated: true };
    },
    { write: true, authentication: false, webOnly: true },
  );
  if (token)
    response.headers.set(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    );
  return response;
}
