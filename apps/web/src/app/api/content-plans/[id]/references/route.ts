import { contentReferenceStatus } from '@productspy/shared';
import { getContentRepository } from '../../../../../lib/server/content-repository';
import { getProductRepository } from '../../../../../lib/server/product-repository';
import { getTemplateRepository } from '../../../../../lib/server/template-repository';
import { getComparisonRepository } from '../../../../../lib/server/comparison-repository';
import { AppError } from '../../../../../lib/server/errors';
import { preflight, withApiRequest } from '../../../../../lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export function GET(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const { id } = await context.params;
      const plan = await getContentRepository().get(id);
      if (!plan) throw new AppError(404, '内容方案不存在。');
      const [product, template, comparison] = await Promise.all([
        getProductRepository().get(plan.productId),
        getTemplateRepository().get(plan.templateSnapshot.id),
        plan.comparisonSource ? getComparisonRepository().get(plan.comparisonSource.id) : undefined,
      ]);
      return contentReferenceStatus(plan, { product, template, comparison });
    },
    { webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET'], { webOnly: true });
}
