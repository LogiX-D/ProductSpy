import { z } from 'zod';
import { MAX_WORKSPACE_BACKUP_BYTES } from '@productspy/shared';
import { WorkspaceBackupService } from '../../../lib/server/business-backup';
import { AppError } from '../../../lib/server/errors';
import { preflight, withApiRequest } from '../../../lib/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Deliberately separate from the smaller ordinary endpoint limit: only this authenticated
// web-only backup API accepts up to 100 MiB plus its fixed request envelope.
async function readBackupRequest(request: Request): Promise<unknown> {
  const limit = MAX_WORKSPACE_BACKUP_BYTES + 2048;
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new AppError(413, '完整备份请求不能超过 100 MiB');
  if (!request.body) throw new AppError(400, '请选择完整业务备份');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new AppError(413, '完整备份请求不能超过 100 MiB');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new AppError(400, '文件不是完整有效的 UTF-8 JSON');
  }
}
export function GET(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const service = new WorkspaceBackupService();
      return new URL(request.url).searchParams.get('status') === '1'
        ? await service.status()
        : await service.export();
    },
    { webOnly: true },
  );
}
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const parsed = z
        .object({
          backup: z.unknown(),
          commit: z.boolean().default(false),
          confirmed: z.boolean().optional(),
          policy: z.enum(['skip', 'preserve']).optional(),
          expectedRevision: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .safeParse(await readBackupRequest(request));
      if (!parsed.success) throw new AppError(400, '恢复请求格式无效，请重新选择备份');
      return new WorkspaceBackupService().restore(parsed.data.backup, parsed.data);
    },
    { webOnly: true, write: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST'], { webOnly: true });
}
