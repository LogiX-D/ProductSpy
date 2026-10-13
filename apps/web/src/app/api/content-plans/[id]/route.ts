import { z } from 'zod';
import {
  contentOptionsSchema,
  contentOutputSchema,
  contentSelectedMediaSchema,
} from '@productspy/shared';
import { getContentRepository } from '../../../../lib/server/content-repository';
import { AppError } from '../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
const patchSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime(),
    name: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['draft', 'needs-edit', 'completed']).optional(),
    favorite: z.boolean().optional(),
    selectedMedia: contentSelectedMediaSchema.optional(),
    options: contentOptionsSchema.optional(),
    output: contentOutputSchema.optional(),
    restoreVersionId: z.string().uuid().optional(),
    adoptVersionId: z.string().uuid().optional(),
  })
  .strict();
export function GET(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const plan = await getContentRepository().get((await context.params).id);
      if (!plan) throw new AppError(404, '内容方案不存在');
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
      if (!input.success) throw new AppError(400, input.error.issues[0]?.message ?? '内容格式无效');
      return getContentRepository().update((await context.params).id, input.data);
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
      if (!input.success) throw new AppError(400, '删除内容方案需要再次确认并提供最新版本。');
      const { id } = await context.params;
      await getContentRepository().delete(id, input.data.expectedUpdatedAt, true);
      return { deletedId: id };
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'PATCH', 'DELETE'], { webOnly: true });
}
