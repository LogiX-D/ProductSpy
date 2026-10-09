import { libraryDefinitionRequestSchema } from '@productspy/shared';
import { AppError } from '../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../lib/server/http';
import { getProductRepository } from '../../../lib/server/product-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, () => getProductRepository().librarySnapshot(), { webOnly: true });
}

export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const parsed = libraryDefinitionRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success)
        throw new AppError(400, parsed.error.issues[0]?.message ?? '分组或标签操作格式无效');
      return getProductRepository().manageDefinition(parsed.data);
    },
    { write: true, webOnly: true },
  );
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST'], { webOnly: true });
}
