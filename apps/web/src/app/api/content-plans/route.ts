import { z } from 'zod';
import { contentOptionsSchema } from '@productspy/shared';
import { getContentRepository } from '../../../lib/server/content-repository';
import { getProductRepository } from '../../../lib/server/product-repository';
import { getTemplateRepository } from '../../../lib/server/template-repository';
import { getComparisonRepository } from '../../../lib/server/comparison-repository';
import { AppError } from '../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../lib/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const inputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    productId: z.string().min(1).max(100),
    templateId: z.string().uuid(),
    options: contentOptionsSchema.optional(),
    comparisonId: z.string().uuid().optional(),
  })
  .strict();
export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, async () => ({ plans: await getContentRepository().list() }), {
    webOnly: true,
  });
}
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const input = inputSchema.safeParse(await readJsonBody(request));
      if (!input.success) throw new AppError(400, '请选择商品、模板并填写方案名称和有效参数。');
      const product = await getProductRepository().get(input.data.productId);
      if (!product) throw new AppError(404, '商品已删除或不存在，请刷新商品库。');
      const template = await getTemplateRepository().get(input.data.templateId);
      if (!template) throw new AppError(404, '模板已删除或不存在，请重新选择。');
      const comparison = input.data.comparisonId
        ? await getComparisonRepository().get(input.data.comparisonId)
        : undefined;
      if (
        input.data.comparisonId &&
        (!comparison?.analysis || !comparison.products.some((item) => item.id === product.id))
      )
        throw new AppError(400, '只能引用包含此商品且已经保存分析的对比方案。');
      return getContentRepository().create(
        input.data.name,
        product,
        template,
        input.data.options,
        comparison,
      );
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST'], { webOnly: true });
}
