import { z } from 'zod';
import { authenticateAccount } from '../../../../lib/saas/security';
import { accountSummary } from '../../../../lib/saas/entitlements';
import { query } from '../../../../lib/saas/database';
import { currentUserId } from '../../../../lib/saas/context';
import { readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { AppError } from '../../../../lib/server/errors';
export const runtime = 'nodejs';
export function GET(request: Request) {
  return withApiRequest(
    request,
    async () => accountSummary((await authenticateAccount(request, true)).user),
    { webOnly: true },
  );
}
export function PATCH(request: Request) {
  return withApiRequest(
    request,
    async () => {
      const parsed = z
        .object({ name: z.string().trim().min(1).max(80) })
        .strict()
        .safeParse(await readJsonBody(request));
      if (!parsed.success) throw new AppError(400, '姓名应为 1–80 个字符');
      await query('UPDATE users SET name=$1 WHERE id=$2', [parsed.data.name, currentUserId()]);
      return accountSummary((await authenticateAccount(request, true)).user);
    },
    { write: true, webOnly: true },
  );
}
