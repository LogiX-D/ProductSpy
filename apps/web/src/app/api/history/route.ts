import { historyKindSchema, historyCleanupSchema } from '@productspy/shared';
import { AppError } from '../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../lib/server/http';
import { cleanupArchivedHistory, historySummary } from '../../../lib/server/history-management';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const query = new URL(request.url).searchParams;
      const kind = historyKindSchema.safeParse(query.get('kind'));
      const id = query.get('id');
      if (!kind.success || !id || id.length > 100)
        throw new AppError(400, '请选择有效的历史资料。');
      return historySummary(kind.data, id);
    },
    { webOnly: true },
  );
}
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const input = historyCleanupSchema.safeParse(await readJsonBody(request));
      if (!input.success)
        throw new AppError(400, '请先导出所选历史，并明确确认清理；当前版本不会删除。');
      return cleanupArchivedHistory(input.data);
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST'], { webOnly: true });
}
