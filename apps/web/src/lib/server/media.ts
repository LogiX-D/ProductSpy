import { AppError } from './errors';
import { identifyMedia } from '@productspy/shared';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const ALLOWED_IMAGE_HOSTS = new Set([
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'images-fe.ssl-images-amazon.com',
  'images-cn.ssl-images-amazon.com',
  'ecx.images-amazon.com',
]);
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export function validateImageUrl(value: string | null): URL {
  if (!value || value.length > 4096) throw new AppError(400, '缺少有效的图片地址');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, '图片地址格式无效');
  }
  if (
    url.protocol !== 'https:' ||
    !ALLOWED_IMAGE_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new AppError(400, '仅支持 Amazon 图片 CDN 的 HTTPS 图片地址');
  }
  url.hash = '';
  return url;
}

export function hasImageSignature(bytes: Uint8Array, contentType: string): boolean {
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 32));
  switch (contentType) {
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, index) => bytes[index] === byte,
      );
    case 'image/webp':
      return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
    case 'image/gif':
      return header.startsWith('GIF87a') || header.startsWith('GIF89a');
    case 'image/avif':
      return header.slice(4, 8) === 'ftyp' && /avif|avis/.test(header.slice(8));
    default:
      return false;
  }
}

function downloadFilename(url: URL, extension: string): string {
  const basename = url.pathname.split('/').pop() ?? 'product-image';
  const stem = basename
    .replace(/\.[^.]*$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 90);
  return `${stem || 'product-image'}.${extension}`;
}

export interface DownloadedImage {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  filename: string;
}

/** Narrow image downloader, never an arbitrary URL proxy. */
export async function fetchAmazonImage(
  value: string | null,
  signal?: AbortSignal,
): Promise<DownloadedImage> {
  const url = validateImageUrl(value);
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
      cache: 'no-store',
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif,image/avif' },
    });
    if (!response.ok || response.redirected) {
      throw new AppError(502, 'Amazon 图片暂时无法下载，可打开原图后手动保存');
    }
    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const extension = IMAGE_EXTENSIONS[contentType];
    if (!extension) {
      await response.body?.cancel();
      throw new AppError(415, '图片响应类型不受支持，仅支持 JPEG、PNG、WebP、GIF 和 AVIF');
    }
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_IMAGE_BYTES)
    ) {
      await response.body?.cancel();
      throw new AppError(413, '图片超过 10 MiB 下载限制，请打开原图后手动保存');
    }
    if (!response.body) throw new AppError(502, '图片响应为空，请打开原图后手动保存');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new AppError(413, '图片超过 10 MiB 下载限制，请打开原图后手动保存');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!length) throw new AppError(502, '图片响应为空，请打开原图后手动保存');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (!hasImageSignature(bytes, contentType)) {
      throw new AppError(415, '响应内容不是有效图片，请打开原图确认素材');
    }
    return { bytes, contentType, filename: downloadFilename(url, extension) };
  } catch (error) {
    if (signal?.aborted) throw new AppError(499, '已取消素材下载');
    if (error instanceof AppError) throw error;
    console.error('[ProductSpy media] Image download failed', error);
    throw new AppError(502, '图片下载失败或超时，请重试，或打开原图后手动保存');
  }
}

export function validateVideoUrl(value: string | null): URL {
  if (!value || value.length > 4096) throw new AppError(400, '缺少有效的视频地址');
  const media = identifyMedia(value, 'video');
  if (media.format === 'hls') throw new AppError(415, 'HLS 视频流不支持直接下载，请打开原始链接');
  if (!media.downloadable)
    throw new AppError(400, '仅支持 Amazon 媒体 CDN 上公开的 MP4 或 WebM HTTPS 视频');
  const url = new URL(value);
  url.hash = '';
  return url;
}

/** Bounded public-file retrieval only; no HLS conversion, cookies, redirects or authentication. */
export async function fetchAmazonVideo(
  value: string | null,
  signal?: AbortSignal,
): Promise<DownloadedImage> {
  const url = validateVideoUrl(value);
  try {
    const response = await fetch(url, {
      redirect: 'error',
      cache: 'no-store',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
      headers: { Accept: 'video/mp4,video/webm' },
    });
    if (!response.ok || response.redirected)
      throw new AppError(502, '视频链接失效或无法公开访问，请打开原始链接确认');
    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const expected = url.pathname.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
    if (contentType !== expected) {
      await response.body?.cancel();
      throw new AppError(415, '视频响应格式不匹配，不下载 HTML、受保护内容或视频流');
    }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_VIDEO_BYTES)) {
      await response.body?.cancel();
      throw new AppError(413, '视频超过 64 MiB 限制，请打开原始链接');
    }
    if (!response.body) throw new AppError(502, '视频响应为空');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_VIDEO_BYTES) {
          await reader.cancel();
          throw new AppError(413, '视频超过 64 MiB 限制，请打开原始链接');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const header = new TextDecoder('ascii').decode(bytes.subarray(0, 32));
    const imageBrands = /avif|avis|heic|heix|hevc|mif1|msf1/;
    const mp4Brands = /isom|iso[2-9]|mp4[12]|avc1|M4V |M4A |qt {2}|dash|MSNV/;
    const valid =
      expected === 'video/mp4'
        ? bytes.length >= 12 &&
          header.slice(4, 8) === 'ftyp' &&
          !imageBrands.test(header.slice(8)) &&
          mp4Brands.test(header.slice(8))
        : [0x1a, 0x45, 0xdf, 0xa3].every((byte, index) => bytes[index] === byte);
    if (!valid) throw new AppError(415, '响应内容不是有效的 MP4 / WebM 视频');
    return {
      bytes,
      contentType,
      filename: downloadFilename(url, expected === 'video/mp4' ? 'mp4' : 'webm'),
    };
  } catch (error) {
    if (signal?.aborted) throw new AppError(499, '已取消素材下载');
    if (error instanceof AppError) throw error;
    console.error('[ProductSpy media] Public video download failed', error);
    throw new AppError(502, '视频下载失败或超时，请重试或打开原始链接');
  }
}
