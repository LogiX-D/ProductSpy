import { changePassword } from '../../../../lib/saas/accounts';
import { accountCookie } from '../../../../lib/saas/config';
import { readJsonBody, withApiRequest } from '../../../../lib/server/http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const response = await withApiRequest(
    request,
    async () => {
      await changePassword(await readJsonBody(request));
      return null;
    },
    { write: true, webOnly: true },
  );
  if (response.ok) response.headers.set('Set-Cookie', accountCookie('', 0));
  return response;
}
