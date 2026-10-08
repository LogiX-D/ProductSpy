import { pairExtension } from '../../../../lib/server/auth';
import { readJsonBody, preflight, withApiRequest } from '../../../../lib/server/http';
import { AppError } from '../../../../lib/server/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || !('code' in body))
        throw new AppError(400, '请输入工作台生成的配对码');
      return pairExtension(request.headers.get('origin') ?? '', body.code);
    },
    { write: true, authentication: false, unpairedExtension: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['POST'], { unpairedExtension: true });
}
