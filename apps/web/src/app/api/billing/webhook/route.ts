import { handleStripeWebhook } from '../../../../lib/saas/billing';
import { jsonFailure } from '../../../../lib/server/http';
import { AppError } from '../../../../lib/server/errors';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  try {
    if (Number(request.headers.get('content-length') ?? 0) > 1024 * 1024)
      throw new AppError(413, 'Webhook 过大');
    if (!request.body) throw new AppError(400, 'Webhook 报文缺失');
    const reader = request.body.getReader();
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1024 * 1024) {
          await reader.cancel();
          throw new AppError(413, 'Webhook 过大');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const data = await handleStripeWebhook(raw, request.headers.get('stripe-signature') ?? '');
    return Response.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonFailure(request, error);
  }
}
