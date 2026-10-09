import { getAnalysisUsageLedger } from '../../../lib/server/analysis-usage';
import { preflight, withApiRequest } from '../../../lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, () => getAnalysisUsageLedger().report(), { webOnly: true });
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET'], { webOnly: true });
}
