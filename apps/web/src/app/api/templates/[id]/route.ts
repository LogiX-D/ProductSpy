import { z } from 'zod';
import { templateDefinitionSchema } from '@productspy/shared';
import { AppError } from '../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { getTemplateRepository } from '../../../../lib/server/template-repository';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
const patchSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime(),
    definition: templateDefinitionSchema.optional(),
    favorite: z.boolean().optional(),
    restoreVersionId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.definition || input.favorite !== undefined || input.restoreVersionId),
    '请指定需要保存的模板资料',
  )
  .refine(
    (input) => !(input.restoreVersionId && (input.definition || input.favorite !== undefined)),
    '请分别保存模板编辑和恢复历史版本',
  );
export function GET(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const template = await getTemplateRepository().get((await context.params).id);
      if (!template) throw new AppError(404, '模板已删除或不存在');
      return template;
    },
    { webOnly: true },
  );
}
export function PATCH(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const parsed = patchSchema.safeParse(await readJsonBody(request));
      if (!parsed.success)
        throw new AppError(400, parsed.error.issues[0]?.message ?? '模板格式无效');
      return getTemplateRepository().update((await context.params).id, parsed.data);
    },
    { write: true, webOnly: true },
  );
}
export function DELETE(request: Request, context: Context): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const parsed = z
        .object({ expectedUpdatedAt: z.string().datetime(), confirmed: z.literal(true) })
        .strict()
        .safeParse(await readJsonBody(request));
      if (!parsed.success) throw new AppError(400, '删除模板需要再次确认并提供最新版本');
      const { id } = await context.params;
      await getTemplateRepository().delete(
        id,
        parsed.data.expectedUpdatedAt,
        parsed.data.confirmed,
      );
      return { deletedId: id };
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'PATCH', 'DELETE'], { webOnly: true });
}
