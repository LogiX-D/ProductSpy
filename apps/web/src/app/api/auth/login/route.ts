import { signIn } from '../../../../lib/saas/accounts';
import { readJsonBody, withApiRequest } from '../../../../lib/server/http';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  let cookie: string | undefined;
  const response = await withApiRequest(
    request,
    async () => {
      const result = await signIn(await readJsonBody(request), false);
      cookie = result.cookie;
      return { user: result.user };
    },
    { write: true, authentication: false, webOnly: true },
  );
  if (cookie) response.headers.set('Set-Cookie', cookie);
  return response;
}
