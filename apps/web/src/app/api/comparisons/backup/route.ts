import { z } from 'zod';
import { MAX_COMPARISON_BACKUP_BYTES } from '@productspy/shared';
import { AppError } from '../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { getComparisonRepository } from '../../../../lib/server/comparison-repository';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const backup = await getComparisonRepository().backup();
      return {
        format: backup.format,
        schemaVersion: backup.schemaVersion,
        exportedAt: backup.exportedAt,
        plans: backup.plans,
      };
    },
    { webOnly: true },
  );
}
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const input = z
        .object({
          backup: z.unknown(),
          commit: z.boolean().default(false),
          expectedRevision: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          policy: z.enum(['skip', 'preserve']).optional(),
        })
        .strict()
        .safeParse(await readJsonBody(request, MAX_COMPARISON_BACKUP_BYTES));
      if (!input.success) throw new AppError(400, '备份导入请求格式无效，请重新选择 JSON 文件。');
      return getComparisonRepository().importBackup(input.data.backup, input.data);
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST'], { webOnly: true });
}
