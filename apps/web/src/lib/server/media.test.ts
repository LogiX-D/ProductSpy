import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GET } from '../../app/api/media/route';
import { fetchAmazonImage, MAX_IMAGE_BYTES, validateImageUrl } from './media';
import { webHeaders } from './test-auth';

const imageUrl = 'https://m.media-amazon.com/images/I/product.jpg';
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

function imageResponse(bytes = jpegBytes, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', ...headers } });
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'productspy-media-'));
  vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('Amazon media download URL boundary', () => {
  it.each([
    'https://m.media-amazon.com/images/I/image.jpg',
    'https://images-na.ssl-images-amazon.com/images/I/image.jpg',
    'https://images-eu.ssl-images-amazon.com/images/I/image.jpg',
    'https://images-fe.ssl-images-amazon.com/images/I/image.jpg',
    'https://images-cn.ssl-images-amazon.com/images/I/image.jpg',
    'https://ecx.images-amazon.com/images/I/image.jpg',
    'https://m.media-amazon.com:443/images/I/image.jpg',
  ])('allows exact Amazon image CDN %s', (url) =>
    expect(validateImageUrl(url).protocol).toBe('https:'),
  );

  it.each([
    null,
    '',
    'not a URL',
    'http://m.media-amazon.com/image.jpg',
    'https://m.media-amazon.com.evil.example/image.jpg',
    'https://evil.example/m.media-amazon.com/image.jpg',
    'https://localhost/image.jpg',
    'https://127.0.0.1/image.jpg',
    'https://m.media-amazon.com:8443/image.jpg',
    'https://user:password@m.media-amazon.com/image.jpg',
    'file:///etc/passwd',
    'data:image/png;base64,dGVzdA==',
  ])('rejects unsafe URL %s before fetching', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAmazonImage(url)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bounded image retrieval', () => {
  it('downloads permitted binary images without following redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);
    const image = await fetchAmazonImage(imageUrl);
    expect(image.bytes).toEqual(jpegBytes);
    expect(image.contentType).toBe('image/jpeg');
    expect(image.filename).toBe('product.jpg');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(imageUrl),
      expect.objectContaining({
        redirect: 'error',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects SVG responses even from a permitted CDN', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
        ),
    );
    await expect(fetchAmazonImage(imageUrl)).rejects.toMatchObject({ status: 415 });
  });

  it('rejects HTML mislabeled as an image', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>captcha</html>', { headers: { 'Content-Type': 'image/jpeg' } }),
        ),
    );
    await expect(fetchAmazonImage(imageUrl)).rejects.toMatchObject({ status: 415 });
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          imageResponse(jpegBytes, { 'Content-Length': String(MAX_IMAGE_BYTES + 1) }),
        ),
    );
    await expect(fetchAmazonImage(imageUrl)).rejects.toMatchObject({ status: 413 });
  });

  it('rejects invalid Content-Length values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(imageResponse(jpegBytes, { 'Content-Length': 'invalid' })),
    );
    await expect(fetchAmazonImage(imageUrl)).rejects.toMatchObject({ status: 413 });
  });

  it('limits streamed bytes even when the declared Content-Length is small', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '1' },
        }),
      ),
    );
    await expect(fetchAmazonImage(imageUrl)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });

  it.each([302, 403, 404, 500])('reports upstream HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    await expect(fetchAmazonImage(imageUrl)).rejects.toMatchObject({ status: 502 });
  });

  it('handles network failure with a comprehensible error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(fetchAmazonImage(imageUrl)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('重试'),
    });
  });
});

describe('media API response', () => {
  it('returns an attachment with no-store and nosniff', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(imageResponse()));
    const response = await GET(
      new Request(`http://localhost:3000/api/media?url=${encodeURIComponent(imageUrl)}`, {
        headers: webHeaders(),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpegBytes);
  });

  it('rejects a nonlocal origin without requesting the CDN', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(
      new Request(`http://localhost:3000/api/media?url=${encodeURIComponent(imageUrl)}`, {
        headers: { Origin: 'https://evil.example' },
      }),
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a JSON error when the image URL is missing', async () => {
    const response = await GET(
      new Request('http://localhost:3000/api/media', { headers: webHeaders() }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
