import { createPortal } from '../../../../lib/saas/billing';
import { readJsonBody, withApiRequest } from '../../../../lib/server/http';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return withApiRequest(
    request,
    async () => {
      await readJsonBody(request);
      return createPortal();
    },
    { write: true, webOnly: true },
  );
}
