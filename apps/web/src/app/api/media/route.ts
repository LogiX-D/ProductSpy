import { assertLocalRequest, corsHeaders, jsonFailure } from '../../../lib/server/http';
import { fetchAmazonImage, fetchAmazonVideo } from '../../../lib/server/media';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await assertLocalRequest(request, false, { webOnly: true });
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
  }
}
