import { assertLocalRequest, corsHeaders, jsonFailure } from '../../../lib/server/http';
import { fetchAmazonImage } from '../../../lib/server/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalRequest(request);
    const image = await fetchAmazonImage(new URL(request.url).searchParams.get('url'));
    const headers = corsHeaders(request);
    headers.set('Content-Type', image.contentType);
    headers.set('Content-Length', String(image.bytes.byteLength));
    headers.set('Content-Disposition', `attachment; filename="${image.filename}"`);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    return new Response(image.bytes, { headers });
  } catch (error) {
    return jsonFailure(request, error);
  }
}
