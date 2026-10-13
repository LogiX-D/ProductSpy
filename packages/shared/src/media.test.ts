import { describe, expect, it } from 'vitest';
import {
  buildProductMediaAssets,
  canonicalMediaUrl,
  identifyMedia,
  safeMediaFilename,
} from './media';
import type { Product } from './types';

const product: Product = {
  id: 'product',
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: '素材样本',
  images: [],
  videos: [],
  bulletPoints: [],
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T01:00:00.000Z',
};
describe('captured media catalogue', () => {
  it('includes real metadata-only resolutions for an existing current-product image', () => {
    const current = 'https://m.media-amazon.com/images/I/71qR76AV9fL._AC_SX300_.jpg';
    const highResolution = 'https://m.media-amazon.com/images/I/71qR76AV9fL._AC_SL1500_.jpg';
    const assets = buildProductMediaAssets({
      ...product,
      images: [current],
      mediaMetadata: [
        {
          url: current,
          kind: 'image',
          width: 300,
          height: 225,
          sourceUrl: product.url,
          productSourceId: product.sourceId,
          extractedAt: product.createdAt,
        },
        {
          url: highResolution,
          kind: 'image',
          width: 1500,
          height: 1125,
          sourceUrl: product.url,
          productSourceId: product.sourceId,
          extractedAt: product.createdAt,
        },
        {
          url: `${highResolution}#duplicate`,
          kind: 'image',
          width: 1500,
          height: 1125,
          sourceUrl: product.url,
          productSourceId: product.sourceId,
          extractedAt: product.createdAt,
        },
      ],
    });
    expect(assets).toHaveLength(1);
    expect(assets[0].variants).toHaveLength(2);
    expect(assets[0]).toMatchObject({
      url: highResolution,
      extractionTimeKnown: true,
      extractedAt: product.createdAt,
      downloadable: true,
    });
    expect(assets[0].variants[0]).toMatchObject({ width: 1500, height: 1125 });
  });
  it('retains an unmeasured captured preferred source rather than defaulting to a measured thumbnail', () => {
    const original = 'https://m.media-amazon.com/images/I/71eGb1FcyiL._AC_SL1500_.jpg';
    const thumbnail = 'https://m.media-amazon.com/images/I/71eGb1FcyiL._AC_SX679_.jpg';
    const assets = buildProductMediaAssets({
      ...product,
      mainImage: original,
      images: [original],
      mediaMetadata: [
        {
          url: original,
          kind: 'image',
          sourceUrl: product.url,
          productSourceId: product.sourceId,
          extractedAt: product.createdAt,
        },
        {
          url: thumbnail,
          kind: 'image',
          width: 679,
          height: 679,
          sourceUrl: product.url,
          productSourceId: product.sourceId,
          extractedAt: product.createdAt,
        },
      ],
    });
    expect(assets[0].url).toBe(original);
    expect(assets[0].variants.map((variant) => variant.url)).toEqual([original, thumbnail]);
    expect(assets[0].variants[0].width).toBeUndefined();
  });
  it('ignores metadata from other ASINs, source pages, country sites or image identities', () => {
    const current = 'https://m.media-amazon.com/images/I/current._AC_SX300_.jpg';
    const highResolution = 'https://m.media-amazon.com/images/I/current._AC_SL1500_.jpg';
    const metadata = {
      url: highResolution,
      kind: 'image' as const,
      width: 1500,
      height: 1500,
      sourceUrl: product.url,
      productSourceId: product.sourceId,
      extractedAt: product.createdAt,
    };
    const assets = buildProductMediaAssets({
      ...product,
      images: [current],
      mediaMetadata: [
        { ...metadata, productSourceId: 'B099999999' },
        { ...metadata, sourceUrl: 'https://www.amazon.com/dp/B099999999' },
        { ...metadata, sourceUrl: 'https://www.amazon.co.jp/dp/B012345678' },
        { ...metadata, sourceUrl: 'https://evil.example/dp/B012345678' },
        { ...metadata, url: 'https://m.media-amazon.com/images/I/recommended.jpg' },
        { ...metadata, url: current, sourceUrl: 'https://www.amazon.com/dp/B099999999' },
      ],
    });
    expect(assets).toHaveLength(1);
    expect(assets[0].variants).toEqual([{ url: current }]);
    expect(assets[0]).toMatchObject({
      extractionTimeKnown: false,
      sourceUrl: product.url,
      extractedAt: product.updatedAt,
    });
  });
  it('deduplicates URLs and groups only actually captured image variants', () => {
    const assets = buildProductMediaAssets({
      ...product,
      mainImage: 'https://m.media-amazon.com/images/I/asset._AC_SX200_.jpg',
      images: [
        'https://m.media-amazon.com/images/I/asset._AC_SX200_.jpg#one',
        'https://m.media-amazon.com/images/I/asset.jpg',
      ],
      mediaMetadata: [
        {
          url: 'https://m.media-amazon.com/images/I/asset.jpg',
          kind: 'image',
          width: 1500,
          height: 1500,
          extractedAt: product.createdAt,
          sourceUrl: product.url,
          productSourceId: product.sourceId,
        },
      ],
    });
    expect(assets).toHaveLength(1);
    expect(assets[0].variants).toHaveLength(2);
    expect(assets[0].url).toBe('https://m.media-amazon.com/images/I/asset.jpg');
    expect(assets[0].productSourceId).toBe(product.sourceId);
    expect(assets[0].variants.map((variant) => variant.url)).not.toContain(
      'https://m.media-amazon.com/images/I/asset._AC_SL2000_.jpg',
    );
  });
  it('preserves signed query strings but removes fragments for URL dedup', () => {
    expect(canonicalMediaUrl('https://m.media-amazon.com/movie.mp4?token=one#anchor')).toBe(
      'https://m.media-amazon.com/movie.mp4?token=one',
    );
    const assets = buildProductMediaAssets({
      ...product,
      videos: [
        { url: 'https://m.media-amazon.com/movie.mp4?token=one#anchor' },
        { url: 'https://m.media-amazon.com/movie.mp4?token=one' },
        { url: 'https://m.media-amazon.com/movie.mp4?token=two' },
      ],
    });
    expect(assets).toHaveLength(2);
  });
  it('backfills provenance from old products without mutating them', () => {
    const old = { ...product, images: ['https://m.media-amazon.com/images/I/image.jpg'] };
    expect(buildProductMediaAssets(old)[0]).toMatchObject({
      productId: product.id,
      sourceUrl: product.url,
      extractedAt: product.updatedAt,
      extractionTimeKnown: false,
    });
    expect(old).not.toHaveProperty('mediaMetadata');
  });
  it('prefers an actually captured HTTPS source over an unsafe larger HTTP variant', () => {
    const safe = 'https://m.media-amazon.com/images/I/asset.jpg';
    const unsafe = 'http://m.media-amazon.com/images/I/asset._AC_SX2000_.jpg';
    const assets = buildProductMediaAssets({
      ...product,
      mainImage: unsafe,
      images: [safe],
      mediaMetadata: [
        {
          url: unsafe,
          kind: 'image',
          width: 2000,
          height: 2000,
          sourceUrl: product.url,
          productSourceId: product.sourceId,
          extractedAt: product.updatedAt,
        },
      ],
    });
    expect(assets[0]).toMatchObject({ url: safe, downloadable: true });
    expect(assets[0].variants).toHaveLength(2);
  });
  it.each([
    'https://evil.example/video.mp4',
    'http://m.media-amazon.com/video.mp4',
    'https://m.media-amazon.com:8443/video.mp4',
    'https://user:secret@m.media-amazon.com/video.mp4',
    'https://m.media-amazon.com.evil.example/video.mp4',
  ])('does not expose download for unsafe video %s', (url) =>
    expect(identifyMedia(url, 'video').downloadable).toBe(false),
  );
  it('recognizes public MP4/WebM, HLS and unknown video formats', () => {
    expect(identifyMedia('https://m.media-amazon.com/video.mp4?signature=x', 'video')).toEqual({
      format: 'mp4',
      downloadable: true,
    });
    expect(identifyMedia('https://m.media-amazon.com/video.webm', 'video')).toEqual({
      format: 'webm',
      downloadable: true,
    });
    expect(identifyMedia('https://m.media-amazon.com/video.m3u8', 'video')).toEqual({
      format: 'hls',
      downloadable: false,
    });
    expect(identifyMedia('https://m.media-amazon.com/video', 'video')).toEqual({
      format: 'unknown',
      downloadable: false,
    });
  });
  it('generates short Windows-safe names containing title, ASIN and media type', () => {
    expect(safeMediaFilename('CON / 中文:商品?\n', 'B012345678', 'image', 2, 'png')).toBe(
      'CON _ 中文_商品__-B012345678-图片-02.png',
    );
    const filename = safeMediaFilename('../'.repeat(200), '../../', 'video', -3, 'exe');
    expect(filename).not.toMatch(/[\\/<>:"|?*\n]/);
    expect(filename.length).toBeLessThan(95);
    expect(filename).toContain('-unknown-视频-01.bin');
  });
});
