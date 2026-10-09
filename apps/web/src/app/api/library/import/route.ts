import {
  MAX_LIBRARY_IMPORT_BYTES,
  parseLibraryImport,
  previewLibraryImport,
  type LibrarySnapshot,
} from '@productspy/shared';
import { z } from 'zod';
import { AppError } from '../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { getProductRepository } from '../../../../lib/server/product-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const requestSchema = z
  .object({
    action: z.enum(['preview', 'commit']),
    data: z.unknown(),
    policy: z.enum(['skip', 'preserve']).optional(),
    confirmed: z.boolean().optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const parsed = requestSchema.safeParse(
        await readJsonBody(request, MAX_LIBRARY_IMPORT_BYTES + 64 * 1024),
      );
      if (!parsed.success) throw new AppError(400, '导入请求格式无效，请重新选择 JSON 文件');
      let incoming: LibrarySnapshot;
      try {
        incoming = parseLibraryImport(parsed.data.data);
      } catch (error) {
        throw new AppError(400, error instanceof Error ? error.message : '导入文件格式无效');
      }
      const repository = getProductRepository();
      if (parsed.data.action === 'preview')
        return previewLibraryImport(incoming, await repository.librarySnapshot());
      if (parsed.data.confirmed !== true || !parsed.data.policy || !parsed.data.expectedRevision)
        throw new AppError(428, '请先预览冲突并确认安全导入；不会覆盖已有商品或分析');
      return repository.importLibrary(incoming, parsed.data.policy, parsed.data.expectedRevision);
    },
    { write: true, webOnly: true },
  );
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['POST'], { webOnly: true });
}
