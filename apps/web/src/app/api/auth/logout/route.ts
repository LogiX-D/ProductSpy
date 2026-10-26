import { signOut } from '../../../../lib/saas/accounts';
import { accountCookie } from '../../../../lib/saas/config';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  const response = await withApiRequest(
    request,
    async () => {
      await readJsonBody(request);
      await signOut(request);
      return null;
    },
    { write: true },
  );
  if (response.ok) response.headers.set('Set-Cookie', accountCookie('', 0));
  return response;
}
export function OPTIONS(request: Request) {
  return preflight(request, ['POST']);
}
