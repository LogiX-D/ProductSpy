import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { getAIAdminChannelSettings, saveAIChannelSettings } from '../../../../lib/ai/channel-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, () => getAIAdminChannelSettings(), { webOnly: true });
}
export function PUT(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => saveAIChannelSettings(await readJsonBody(request, 256 * 1024)),
    { webOnly: true, write: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'PUT'], { webOnly: true });
}
