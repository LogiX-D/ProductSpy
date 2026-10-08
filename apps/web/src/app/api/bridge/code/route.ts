import { generatePairCode } from '../../../../lib/server/auth';
import { readJsonBody, withApiRequest } from '../../../../lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      await readJsonBody(request);
      return generatePairCode();
    },
    { write: true, webOnly: true },
  );
}
