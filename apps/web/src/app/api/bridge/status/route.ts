import { bridgeStatus } from '../../../../lib/server/auth';
import { withApiRequest } from '../../../../lib/server/http';
import { saasEnabled, currentUserId } from '../../../../lib/saas/context';
import { authenticateAccount } from '../../../../lib/saas/security';
import { query } from '../../../../lib/saas/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request): Promise<Response> {
  if (saasEnabled())
    return withApiRequest(request, async () => {
      const identity = await authenticateAccount(request);
      if (identity.kind === 'extension') return { paired: true, user: identity.user };
      const { rows } = await query(
        "SELECT token_hash FROM sessions WHERE user_id=$1 AND kind='extension' AND revoked_at IS NULL AND expires_at>now() LIMIT 1",
        [currentUserId()],
      );
      return { paired: rows.length > 0, user: identity.user };
    });
  return withApiRequest(request, bridgeStatus, { webOnly: true });
}
export { OPTIONS } from '../pair/route';
