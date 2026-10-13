import { z } from 'zod';
import { comparisonAnalysisSchema } from '@productspy/shared';
import { AppError } from '../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { getComparisonRepository } from '../../../../lib/server/comparison-repository';
import { getProductRepository } from '../../../../lib/server/product-repository';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
const patchSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime(),
    name: z.string().trim().min(1).max(120).optional(),
    productIds: z
      .array(z.string().min(1).max(100))
      .min(2)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    refreshSnapshots: z.literal(true).optional(),
    analysis: comparisonAnalysisSchema.optional(),
    restoreVersionId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (input) =>
      !(input.analysis && input.restoreVersionId) &&
      !(
        (input.analysis || input.restoreVersionId) &&
        (input.productIds || input.refreshSnapshots || input.name)
      ),
    '请分别保存方案资料和分析版本',
  );
export function GET(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const plan = await getComparisonRepository().get((await context.params).id);
      if (!plan) throw new AppError(404, '对比方案已删除或不存在');
      return plan;
    },
    { webOnly: true },
  );
}
export function PATCH(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const input = patchSchema.safeParse(await readJsonBody(request));
      if (!input.success)
        throw new AppError(400, input.error.issues[0]?.message ?? '对比方案格式无效');
      const { id } = await context.params;
      const repository = getComparisonRepository();
      if (input.data.analysis)
        return repository.saveAnalysis(id, input.data.analysis, input.data.expectedUpdatedAt);
      if (input.data.restoreVersionId)
        return repository.restoreAnalysis(
          id,
          input.data.restoreVersionId,
          input.data.expectedUpdatedAt,
        );
      return repository.update(id, input.data, await getProductRepository().list());
    },
    { write: true, webOnly: true },
  );
}
export function DELETE(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const input = z
        .object({ expectedUpdatedAt: z.string().datetime(), confirmed: z.literal(true) })
        .strict()
        .safeParse(await readJsonBody(request));
      if (!input.success) throw new AppError(400, '删除方案需要再次确认并提供最新版本');
      const { id } = await context.params;
      await getComparisonRepository().delete(
        id,
        input.data.expectedUpdatedAt,
        input.data.confirmed,
      );
      return { deletedId: id };
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'PATCH', 'DELETE'], { webOnly: true });
}
