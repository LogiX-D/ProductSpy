import type { Product } from './types';
import { AMAZON_DOMAINS, isAmazonProductUrl } from './schema';

export type MediaKind = 'image' | 'video';
export type MediaFormat = 'image' | 'mp4' | 'webm' | 'hls' | 'unknown';
export interface MediaVariant {
  url: string;
  width?: number;
  height?: number;
}
export interface MediaAsset {
  id: string;
  kind: MediaKind;
  format: MediaFormat;
  downloadable: boolean;
  variants: MediaVariant[];
  url: string;
  thumbnail?: string;
  sourceUrl: string;
  productId: string;
  productSourceId: string;
  extractedAt: string;
  extractionTimeKnown: boolean;
}
export interface MediaDownloadEntry {
  assetId: string;
  kind: MediaKind;
  sourceUrl: string;
  sourcePage: string;
  productId: string;
  asin: string;
  extractedAt: string;
  extractionTimeKnown?: boolean;
  status: 'saved' | 'duplicate' | 'failed' | 'cancelled';
  filename?: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  error?: string;
}
export interface MediaDownloadJob {
  id: string;
  directory: string;
  expiresAt: string;
  manifestFilename: string;
  entries: MediaDownloadEntry[];
  cancelled: boolean;
}

const IMAGE_HOSTS = new Set([
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'images-fe.ssl-images-amazon.com',
  'images-cn.ssl-images-amazon.com',
  'ecx.images-amazon.com',
]);
const VIDEO_HOSTS = new Set(['m.media-amazon.com', 'images-na.ssl-images-amazon.com']);

/** Keep signed query strings intact; fragments do not identify different media bytes. */
export function canonicalMediaUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return value;
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

export function identifyMedia(
  value: string,
  kind: MediaKind,
): {
  format: MediaFormat;
  downloadable: boolean;
} {
  try {
    const url = new URL(value);
    const safe = url.protocol === 'https:' && !url.username && !url.password && !url.port;
    if (kind === 'image')
      return { format: 'image', downloadable: safe && IMAGE_HOSTS.has(url.hostname) };
    const extension = url.pathname.toLowerCase().match(/\.(mp4|webm|m3u8)$/)?.[1];
    const format: MediaFormat =
      extension === 'm3u8' ? 'hls' : (extension as 'mp4' | 'webm') || 'unknown';
    return {
      format,
      downloadable: safe && VIDEO_HOSTS.has(url.hostname) && ['mp4', 'webm'].includes(format),
    };
  } catch {
    return { format: kind === 'image' ? 'image' : 'unknown', downloadable: false };
  }
}

function imageIdentity(value: string): string {
  try {
    const url = new URL(value);
    if (IMAGE_HOSTS.has(url.hostname)) {
      const filename = url.pathname.match(/^\/images\/I\/([^/]+)$/)?.[1];
      // Group only URLs that were really captured; this never constructs a new CDN URL.
      const identity = filename?.replace(/\._[^.]*_\.(\w+)$/, '.$1');
      if (identity) return `${url.hostname}/images/I/${identity}${url.search}`;
    }
  } catch {
    // Imported invalid addresses remain visible but are not downloadable.
  }
  return canonicalMediaUrl(value);
}

function belongsToProductCapture(sourceUrl: string, sourceId: string, product: Product): boolean {
  if (sourceId !== product.sourceId || !isAmazonProductUrl(sourceUrl)) return false;
  try {
    const source = new URL(sourceUrl);
    const productUrl = new URL(product.url);
    const asin = source.pathname.match(
      /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i,
    )?.[1];
    const site = (hostname: string) =>
      AMAZON_DOMAINS.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    return (
      asin?.toUpperCase() === product.sourceId &&
      site(source.hostname) === site(productUrl.hostname)
    );
  } catch {
    return false;
  }
}

export function buildProductMediaAssets(product: Product): MediaAsset[] {
  const images = [
    ...new Set([product.mainImage, ...product.images].filter((url): url is string => Boolean(url))),
  ];
  const grouped = new Map<string, MediaAsset>();
  const metadata = (product.mediaMetadata ?? []).filter((item) =>
    belongsToProductCapture(item.sourceUrl, item.productSourceId, product),
  );
  for (const url of images) {
    const key = imageIdentity(url);
    const evidence = metadata.find(
      (item) => item.kind === 'image' && canonicalMediaUrl(item.url) === canonicalMediaUrl(url),
    );
    const variant: MediaVariant = {
      url,
      ...(evidence?.width ? { width: evidence.width } : {}),
      ...(evidence?.height ? { height: evidence.height } : {}),
    };
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.variants.some((item) => canonicalMediaUrl(item.url) === canonicalMediaUrl(url)))
        existing.variants.push(variant);
      continue;
    }
    grouped.set(key, {
      id: `image-${grouped.size + 1}`,
      kind: 'image',
      ...identifyMedia(url, 'image'),
      variants: [variant],
      url,
      sourceUrl: evidence?.sourceUrl ?? product.url,
      productId: product.id,
      productSourceId: product.sourceId,
      extractedAt: evidence?.extractedAt ?? product.updatedAt,
      extractionTimeKnown: Boolean(evidence?.extractedAt),
    });
  }
  // Metadata may contain additional genuine resolutions that images[] intentionally omitted.
  // Attach them only to an image already present in this product, never create recommendation assets.
  for (const evidence of metadata) {
    if (evidence.kind !== 'image' || !identifyMedia(evidence.url, 'image').downloadable) continue;
    const existing = grouped.get(imageIdentity(evidence.url));
    if (
      !existing ||
      existing.variants.some(
        (item) => canonicalMediaUrl(item.url) === canonicalMediaUrl(evidence.url),
      )
    )
      continue;
    existing.variants.push({
      url: evidence.url,
      ...(evidence.width ? { width: evidence.width } : {}),
      ...(evidence.height ? { height: evidence.height } : {}),
    });
  }
  const assets = [...grouped.values()];
  for (const asset of assets) {
    const capturedPreferred = asset.variants[0];
    const preserveUnknownPreferred =
      identifyMedia(capturedPreferred.url, 'image').downloadable &&
      metadata.some(
        (item) =>
          item.kind === 'image' &&
          canonicalMediaUrl(item.url) === canonicalMediaUrl(capturedPreferred.url),
      ) &&
      !(capturedPreferred.width && capturedPreferred.height);
    asset.variants.sort((a, b) => {
      const eligibility =
        Number(identifyMedia(b.url, 'image').downloadable) -
        Number(identifyMedia(a.url, 'image').downloadable);
      if (eligibility) return eligibility;
      // Preserve the extractor's genuine preferred URL when its size is unknown.
      if (a === b) return 0;
      if (preserveUnknownPreferred && a === capturedPreferred) return -1;
      if (preserveUnknownPreferred && b === capturedPreferred) return 1;
      return (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0);
    });
    asset.url = asset.variants[0].url;
    Object.assign(asset, identifyMedia(asset.url, 'image'));
    const selectedEvidence = metadata.find(
      (item) =>
        item.kind === 'image' && canonicalMediaUrl(item.url) === canonicalMediaUrl(asset.url),
    );
    asset.extractedAt = selectedEvidence?.extractedAt ?? product.updatedAt;
    asset.extractionTimeKnown = Boolean(selectedEvidence?.extractedAt);
    asset.sourceUrl = selectedEvidence?.sourceUrl ?? product.url;
  }
  const videoUrls = new Set<string>();
  for (const video of product.videos) {
    const key = canonicalMediaUrl(video.url);
    if (videoUrls.has(key)) continue;
    videoUrls.add(key);
    const evidence = metadata.find(
      (item) => item.kind === 'video' && canonicalMediaUrl(item.url) === key,
    );
    assets.push({
      id: `video-${videoUrls.size}`,
      kind: 'video',
      ...identifyMedia(video.url, 'video'),
      variants: [{ url: video.url }],
      url: video.url,
      ...(video.thumbnail ? { thumbnail: video.thumbnail } : {}),
      sourceUrl: evidence?.sourceUrl ?? product.url,
      productId: product.id,
      productSourceId: product.sourceId,
      extractedAt: evidence?.extractedAt ?? product.updatedAt,
      extractionTimeKnown: Boolean(evidence?.extractedAt),
    });
  }
  return assets;
}

export function safeMediaFilename(
  title: string,
  asin: string,
  kind: MediaKind,
  index: number,
  extension: string,
): string {
  const clean =
    title
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*]/g, '_')
      .split('')
      .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 52) || '商品';
  const safeAsin = asin.replace(/[^A-Z0-9]/gi, '').slice(0, 20) || 'unknown';
  const safeExtension = [
    'jpg',
    'png',
    'webp',
    'gif',
    'avif',
    'mp4',
    'webm',
    'zip',
    'json',
  ].includes(extension)
    ? extension
    : 'bin';
  const safeIndex = Number.isSafeInteger(index) && index > 0 ? index : 1;
  return `${clean}-${safeAsin}-${kind === 'image' ? '图片' : '视频'}-${String(safeIndex).padStart(2, '0')}.${safeExtension}`;
}
