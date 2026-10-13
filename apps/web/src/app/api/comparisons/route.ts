import { z } from 'zod';
import { AppError } from '../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../lib/server/http';
import { getComparisonRepository } from '../../../lib/server/comparison-repository';
import { getProductRepository } from '../../../lib/server/product-repository';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    productIds: z
      .array(z.string().min(1).max(100))
      .min(2)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, async () => ({ plans: await getComparisonRepository().list() }), {
    webOnly: true,
  });
}
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const parsed = createSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw new AppError(400, '请填写方案名称并选择 2–5 个不同商品');
      const products = await getProductRepository().list();
      const selected = parsed.data.productIds.map((id) =>
        products.find((product) => product.id === id),
      );
      if (selected.some((product) => !product))
        throw new AppError(409, '选中的商品已删除，请刷新商品库');
      return getComparisonRepository().create(
        parsed.data.name,
        selected.filter((product) => product !== undefined),
      );
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST'], { webOnly: true });
}
