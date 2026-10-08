import { bridgeStatus } from '../../../../lib/server/auth';
import { withApiRequest } from '../../../../lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, bridgeStatus, { webOnly: true });
}
