import { analysisSchema, productSchema } from '@productspy/shared';
import { createAIProvider, withProductAnalysisLock } from '../../../lib/ai';
import { AppError } from '../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../lib/server/http';
import { getProductRepository } from '../../../lib/server/product-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const parsed = productSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw new AppError(400, '商品数据不完整，请刷新商品后重新分析');
      const repository = getProductRepository();
      const product = await repository.get(parsed.data.id);
      if (!product) throw new AppError(404, '商品已删除或不存在，请返回商品库刷新');
      if (product.updatedAt !== parsed.data.updatedAt)
        throw new AppError(409, '商品资料已更新，请刷新商品后重新分析');
      return withProductAnalysisLock(`${repository.filePath}:${product.id}`, async () => {
        const provider = createAIProvider();
        const analysis = analysisSchema.safeParse(await provider.analyze(product));
        if (!analysis.success) throw new AppError(502, 'AI 分析字段不完整，请重新分析');
        await repository.saveAnalysis(product.id, analysis.data, product.updatedAt);
        return analysis.data;
      });
    },
    { write: true },
  );
}

export function OPTIONS(request: Request): Response {
  return preflight(request, ['POST']);
}
