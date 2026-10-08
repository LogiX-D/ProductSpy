import { analysisSchema, productSchema } from '@productspy/shared';
import { AppError } from '../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { getProductRepository } from '../../../../lib/server/product-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, context: Context): Promise<Response> {
  return withApiRequest(request, async () => {
    const { id } = await context.params;
    const product = await getProductRepository().get(id);
    if (!product) throw new AppError(404, '商品已删除或不存在');
    return product;
  });
}

export function DELETE(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const { id } = await context.params;
      await getProductRepository().delete(id);
      return null;
    },
    { write: true },
  );
}

export function PATCH(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const { id } = await context.params;
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || !('analysis' in body)) {
        throw new AppError(400, '请求缺少有效的分析结果');
      }
      const analysis = analysisSchema.safeParse(body.analysis);
      if (!analysis.success) throw new AppError(400, '分析结果格式不完整，请重新分析');
      const version = 'expectedUpdatedAt' in body ? body.expectedUpdatedAt : undefined;
      const expectedUpdatedAt = productSchema.shape.updatedAt.optional().safeParse(version);
      if (!expectedUpdatedAt.success) throw new AppError(400, '商品版本格式无效，请刷新后重试');
      return getProductRepository().saveAnalysis(id, analysis.data, expectedUpdatedAt.data);
    },
    { write: true },
  );
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'DELETE', 'PATCH']);
}
