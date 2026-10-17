import { query } from '../../../lib/saas/database';
import { saasEnabled } from '../../../lib/saas/context';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    if (saasEnabled()) await query('SELECT 1');
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (['test', 'development'].includes(process.env.PRODUCTSPY_ENV ?? ''))
      console.error(
        '[ProductSpy development health]',
        error instanceof Error ? error.message : 'Database initialization failed',
      );
    return Response.json({ ok: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
