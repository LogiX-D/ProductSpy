import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAmazonImage, fetchAmazonVideo, MAX_VIDEO_BYTES, validateVideoUrl } from './media';

const url = 'https://m.media-amazon.com/images/S/video.mp4?signature=test';
const mp4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
afterEach(() => vi.unstubAllGlobals());
describe('direct public video policy', () => {
  it('allows exact CDN MP4/WebM URLs without losing signed parameters', () => {
    expect(validateVideoUrl(url).search).toBe('?signature=test');
    expect(validateVideoUrl('https://m.media-amazon.com/a.webm').pathname).toBe('/a.webm');
  });
  it.each([
    'https://m.media-amazon.com/a.m3u8',
    'https://m.media-amazon.com/a',
    'https://evil.example/a.mp4',
    'https://s3.amazonaws.com/a.mp4',
    'http://m.media-amazon.com/a.mp4',
    'https://m.media-amazon.com:8443/a.mp4',
    'https://user:password@m.media-amazon.com/a.mp4',
  ])('rejects unsupported video %s before network requests', async (value) => {
    const retrieve = vi.fn();
    vi.stubGlobal('fetch', retrieve);
    await expect(fetchAmazonVideo(value)).rejects.toBeDefined();
    expect(retrieve).not.toHaveBeenCalled();
  });
  it('checks MIME, file signature and disables redirects', async () => {
    const retrieve = vi
      .fn()
      .mockResolvedValue(new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', retrieve);
    expect(await fetchAmazonVideo(url)).toMatchObject({ bytes: mp4, contentType: 'video/mp4' });
    expect(retrieve).toHaveBeenCalledWith(
      new URL(url),
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
        cache: 'no-store',
      }),
    );
  });
  it('rejects HTML challenges mislabeled as MP4', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>Challenge</html>', { headers: { 'Content-Type': 'video/mp4' } }),
        ),
    );
    await expect(fetchAmazonVideo(url)).rejects.toMatchObject({ status: 415 });
  });
  it('rejects AVIF image containers masquerading as MP4 video', async () => {
    const image = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(image, { headers: { 'Content-Type': 'video/mp4' } })),
    );
    await expect(fetchAmazonVideo(url)).rejects.toMatchObject({ status: 415 });
  });
  it('rejects a format mismatch and oversized declared video before reading', async () => {
    const retrieve = vi
      .fn()
      .mockResolvedValueOnce(new Response(mp4, { headers: { 'Content-Type': 'video/webm' } }))
      .mockResolvedValueOnce(
        new Response(mp4, {
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(MAX_VIDEO_BYTES + 1) },
        }),
      );
    vi.stubGlobal('fetch', retrieve);
    await expect(fetchAmazonVideo(url)).rejects.toMatchObject({ status: 415 });
    await expect(fetchAmazonVideo(url)).rejects.toMatchObject({ status: 413 });
  });
  it('rejects protected or expired upstream responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(fetchAmazonVideo(url)).rejects.toMatchObject({ status: 502 });
  });
  it('propagates intentional cancellation without retrying image or video requests', async () => {
    const controller = new AbortController();
    controller.abort();
    const retrieve = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', retrieve);
    await expect(fetchAmazonVideo(url, controller.signal)).rejects.toMatchObject({ status: 499 });
    await expect(
      fetchAmazonImage('https://m.media-amazon.com/a.jpg', controller.signal),
    ).rejects.toMatchObject({ status: 499 });
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});
