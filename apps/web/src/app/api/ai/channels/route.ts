import { preflight, withApiRequest } from '../../../../lib/server/http';
import { getAIChannelCatalog } from '../../../../lib/ai/channels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, () => getAIChannelCatalog(), { webOnly: true });
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET'], { webOnly: true });
}
