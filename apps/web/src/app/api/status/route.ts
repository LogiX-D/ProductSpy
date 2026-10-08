import { preflight, withApiRequest } from '../../../lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, () => {
    const explicitMode = process.env.AI_MODE;
    const mode =
      explicitMode === 'mock' || (!process.env.AI_API_KEY && explicitMode !== 'real')
        ? 'mock'
        : 'real';
    return { mode, version: '0.1.0' };
  });
}

export function OPTIONS(request: Request): Response {
  return preflight(request, ['GET']);
}
