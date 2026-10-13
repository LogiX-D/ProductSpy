import { z } from 'zod';
import { MAX_TEMPLATE_BACKUP_BYTES } from '@productspy/shared';
import { AppError } from '../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { getTemplateRepository } from '../../../../lib/server/template-repository';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, () => getTemplateRepository().backup(), { webOnly: true });
}
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const parsed = z
        .object({
          backup: z.unknown(),
          commit: z.boolean().default(false),
          expectedRevision: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          policy: z.literal('skip').optional(),
        })
        .strict()
        .safeParse(await readJsonBody(request, MAX_TEMPLATE_BACKUP_BYTES + 1024));
      if (!parsed.success) throw new AppError(400, '模板导入请求格式无效，请重新选择 JSON 文件');
      return getTemplateRepository().importBackup(parsed.data.backup, parsed.data);
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST'], { webOnly: true });
}
