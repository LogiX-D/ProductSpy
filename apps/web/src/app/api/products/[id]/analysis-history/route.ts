import { z } from 'zod';
import { AppError } from '../../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../../lib/server/http';
import { getProductRepository } from '../../../../../lib/server/product-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
const restoreSchema = z.object({
  versionId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
});

export function GET(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const { id } = await context.params;
      return getProductRepository().analysisHistory(id);
    },
    { webOnly: true },
  );
}

export function POST(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const { id } = await context.params;
      const parsed = restoreSchema.safeParse(await readJsonBody(request));
      if (!parsed.success)
        throw new AppError(400, '请选择有效的历史版本，并提供当前商品版本后再恢复');
      return getProductRepository().restoreAnalysis(
        id,
        parsed.data.versionId,
        parsed.data.expectedUpdatedAt,
      );
    },
    { write: true, webOnly: true },
  );
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST'], { webOnly: true });
}
