import {
  createWebSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from '../../../lib/server/auth';
import { readJsonBody, withApiRequest } from '../../../lib/server/http';
import { saasEnabled } from '../../../lib/saas/context';
import { GET as accountSession } from '../auth/me/route';
import { AppError } from '../../../lib/server/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (saasEnabled())
    return withApiRequest(
      request,
      () => {
        throw new AppError(401, '请登录账号，不能自动创建匿名会话');
      },
      { write: true, authentication: false, webOnly: true },
    );
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
export function GET(request: Request): Promise<Response> {
  return accountSession(request);
}
