import { generatePairCode } from '../../../../lib/server/auth';
import { readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { saasEnabled } from '../../../../lib/saas/context';
import { cloudPairCode } from '../../../../lib/saas/accounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      if (saasEnabled()) return cloudPairCode(await readJsonBody(request));
      await readJsonBody(request);
      return generatePairCode();
    },
    { write: true, webOnly: true },
  );
}
