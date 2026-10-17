import { preflight, withApiRequest } from '../../../lib/server/http';
import { PRODUCTSPY_VERSION } from '@productspy/shared';
import { saasEnabled } from '../../../lib/saas/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    () => {
      const explicitMode = process.env.AI_MODE;
      const mode =
        explicitMode === 'mock' || (!process.env.AI_API_KEY?.trim() && explicitMode !== 'real')
          ? 'mock'
          : 'real';
      return { mode, version: PRODUCTSPY_VERSION, ...(saasEnabled() ? { status: 'ok' } : {}) };
    },
    { authentication: false },
  );
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET']);
}
