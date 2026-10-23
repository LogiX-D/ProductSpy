import { revokeExtension } from '../../../../lib/server/auth';
import { readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { saasEnabled, currentUserId } from '../../../../lib/saas/context';
import { query } from '../../../../lib/saas/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      await readJsonBody(request);
      if (saasEnabled()) {
        await query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND kind='extension'", [
          currentUserId(),
        ]);
        await query(
          'UPDATE extension_codes SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',
          [currentUserId()],
        );
        return null;
      }
      await revokeExtension();
      return null;
    },
    { write: true, webOnly: true },
  );
}
