import { assertLocalRequest, corsHeaders, jsonFailure } from '../../../lib/server/http';
import { fetchAmazonImage, fetchAmazonVideo } from '../../../lib/server/media';
import { createHash } from 'node:crypto';
import { saasEnabled } from '../../../lib/saas/context';
import { authenticateAccount, rateLimit } from '../../../lib/saas/security';
import { AppError } from '../../../lib/server/errors';

const mediaState = globalThis as typeof globalThis & { __productspyActiveMedia?: number };

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  let reserved = false;
  try {
    await assertLocalRequest(request, false, { webOnly: true });
    if (saasEnabled()) {
      const identity = await authenticateAccount(request, true);
      await rateLimit(`media:${identity.user.id}`, 12);
      await rateLimit('media:all-users', 120);
      if ((mediaState.__productspyActiveMedia ?? 0) >= 2)
        throw new AppError(429, '素材下载繁忙，请稍后重试');
      mediaState.__productspyActiveMedia = (mediaState.__productspyActiveMedia ?? 0) + 1;
      reserved = true;
    }
    const params = new URL(request.url).searchParams;
    const image =
      params.get('kind') === 'video'
        ? await fetchAmazonVideo(params.get('url'), request.signal)
        : await fetchAmazonImage(params.get('url'), request.signal);
    const headers = corsHeaders(request);
    headers.set('Content-Type', image.contentType);
    headers.set('Content-Length', String(image.bytes.byteLength));
    headers.set('Content-Disposition', `attachment; filename="${image.filename}"`);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-ProductSpy-SHA256', createHash('sha256').update(image.bytes).digest('hex'));
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    return new Response(image.bytes, { headers });
  } catch (error) {
    return jsonFailure(request, error);
  } finally {
    if (reserved)
      mediaState.__productspyActiveMedia = Math.max(
        0,
        (mediaState.__productspyActiveMedia ?? 1) - 1,
      );
  }
}
