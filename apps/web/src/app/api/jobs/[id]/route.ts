import { getJob } from '../../../../lib/saas/jobs';
import { withApiRequest } from '../../../../lib/server/http';
export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiRequest(request, async () => getJob((await context.params).id), { webOnly: true });
}
