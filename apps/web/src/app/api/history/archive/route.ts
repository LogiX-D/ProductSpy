import { historySelectionSchema } from '@productspy/shared';
import { AppError } from '../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { exportHistoryArchive } from '../../../../lib/server/history-management';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const input = historySelectionSchema.safeParse(await readJsonBody(request));
      if (!input.success) throw new AppError(400, '请选择有效的历史版本并刷新当前资料。');
      return exportHistoryArchive(input.data);
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['POST'], { webOnly: true });
}
