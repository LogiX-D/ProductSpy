import { describe, expect, it } from 'vitest';
import type { Product, ProductAnalysis } from '@productspy/shared';
import {
  clearLibraryFilters,
  DEFAULT_LIBRARY_PREFERENCES,
  hasLibraryFilters,
  restoreLibraryPreferences,
  selectLibraryProducts,
  paginateLibraryProducts,
} from './workspace-preferences';

const analysis: ProductAnalysis = {
  summary: '测试分析',
  sellingPoints: [],
  targetAudience: [],
  purchaseMotivations: [],
  painPoints: [],
  strengths: [],
  weaknesses: [],
  marketingAngles: [],
  hooks: [],
  shortVideoScript: '',
  imagePrompts: [],
  videoPrompts: [],
};
function product(id: string, extra: Partial<Product> = {}): Product {
  return {
    id,
    source: 'amazon',
    sourceId: id,
    url: `https://www.amazon.com/dp/${id}`,
    title: id,
    images: [],
    videos: [],
    bulletPoints: [],
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...extra,
  };
}

describe('workspace library selection', () => {
  const products = [
    product('B000000002', {
      title: 'Travel Bottle 2',
      brand: 'Acme',
      createdAt: '2026-10-02T08:00:00Z',
      updatedAt: '2026-10-04T08:00:00Z',
    }),
    product('B000000001', {
      title: 'Travel Bottle 10',
      brand: 'Other',
      aiAnalysis: analysis,
      createdAt: '2026-10-03T08:00:00Z',
      updatedAt: '2026-10-03T08:00:00Z',
    }),
  ];
  it('searches titles, brands and ASIN with whitespace and case normalization', () => {
    expect(
      selectLibraryProducts(products, { ...DEFAULT_LIBRARY_PREFERENCES, query: '  acME  ' }).map(
        (p) => p.id,
      ),
    ).toEqual(['B000000002']);
    expect(
      selectLibraryProducts(products, { ...DEFAULT_LIBRARY_PREFERENCES, query: 'travel' }),
    ).toHaveLength(2);
    expect(
      selectLibraryProducts(products, { ...DEFAULT_LIBRARY_PREFERENCES, query: 'b000000001' }).map(
        (p) => p.id,
      ),
    ).toEqual(['B000000001']);
  });
  it('combines analysis, source and search filters', () => {
    expect(
      selectLibraryProducts(products, {
        ...DEFAULT_LIBRARY_PREFERENCES,
        source: 'amazon',
        analysis: 'pending',
        query: 'bottle',
      }).map((p) => p.id),
    ).toEqual(['B000000002']);
    expect(
      selectLibraryProducts(products, {
        ...DEFAULT_LIBRARY_PREFERENCES,
        analysis: 'analyzed',
        query: 'Acme',
      }),
    ).toEqual([]);
    expect(
      selectLibraryProducts(products, { ...DEFAULT_LIBRARY_PREFERENCES, analysis: 'analyzed' }).map(
        (p) => p.id,
      ),
    ).toEqual(['B000000001']);
  });
  it('sorts updates independently of collection dates without mutating the source', () => {
    expect(selectLibraryProducts(products, DEFAULT_LIBRARY_PREFERENCES).map((p) => p.id)).toEqual([
      'B000000002',
      'B000000001',
    ]);
    expect(
      selectLibraryProducts(products, {
        ...DEFAULT_LIBRARY_PREFERENCES,
        sort: 'collected-desc',
      }).map((p) => p.id),
    ).toEqual(['B000000001', 'B000000002']);
    expect(
      selectLibraryProducts(products, {
        ...DEFAULT_LIBRARY_PREFERENCES,
        sort: 'collected-asc',
      }).map((p) => p.id),
    ).toEqual(['B000000002', 'B000000001']);
    expect(products.map((p) => p.id)).toEqual(['B000000002', 'B000000001']);
  });
  it('sorts titles naturally and orders timestamp ties consistently', () => {
    expect(
      selectLibraryProducts([...products].reverse(), {
        ...DEFAULT_LIBRARY_PREFERENCES,
        sort: 'title-asc',
      }).map((p) => p.id),
    ).toEqual(['B000000002', 'B000000001']);
    expect(
      selectLibraryProducts([product('z'), product('a')], DEFAULT_LIBRARY_PREFERENCES).map(
        (p) => p.id,
      ),
    ).toEqual(['a', 'z']);
  });
  it('handles missing optional brand and invalid timestamps safely', () => {
    expect(
      selectLibraryProducts(
        [product('missing', { updatedAt: 'invalid' }), product('valid')],
        DEFAULT_LIBRARY_PREFERENCES,
      ).map((p) => p.id),
    ).toEqual(['valid', 'missing']);
    expect(
      selectLibraryProducts([product('missing')], {
        ...DEFAULT_LIBRARY_PREFERENCES,
        query: 'brand',
      }),
    ).toEqual([]);
  });
  it('combines group, tag and analysis filters without altering old products', () => {
    const group = '00000000-0000-4000-8000-000000000001';
    const tag = '00000000-0000-4000-8000-000000000002';
    const samples = [
      product('old'),
      product('matched', { groupIds: [group], tagIds: [tag], aiAnalysis: analysis }),
      product('only-group', { groupIds: [group] }),
    ];
    expect(
      selectLibraryProducts(samples, {
        ...DEFAULT_LIBRARY_PREFERENCES,
        group,
        tag,
        analysis: 'analyzed',
      }).map((item) => item.id),
    ).toEqual(['matched']);
    expect(
      selectLibraryProducts(samples, {
        ...DEFAULT_LIBRARY_PREFERENCES,
        group: 'none',
        tag: 'none',
      }).map((item) => item.id),
    ).toEqual(['old']);
    expect(samples[0]).not.toHaveProperty('groupIds');
  });
  it('bounds rendering for 100 and 500 products and recovers out-of-range pages', () => {
    for (const count of [100, 500]) {
      const samples = Array.from({ length: count }, (_, index) => product(`item-${index}`));
      expect(paginateLibraryProducts(samples, 1).products).toHaveLength(36);
      const last = paginateLibraryProducts(samples, 999);
      expect(last.currentPage).toBe(Math.ceil(count / 36));
      expect(last.products.length).toBeLessThanOrEqual(36);
      expect(paginateLibraryProducts(samples, -20).currentPage).toBe(1);
      expect(samples).toHaveLength(count);
    }
    expect(paginateLibraryProducts([], 5)).toEqual({ products: [], currentPage: 1, totalPages: 1 });
  });
});

describe('workspace preference restoration', () => {
  it('round trips search, filter, sorting and grid/list preferences', () => {
    const saved = {
      ...DEFAULT_LIBRARY_PREFERENCES,
      query: 'Acme',
      source: 'amazon' as const,
      analysis: 'pending' as const,
      sort: 'collected-desc' as const,
      layout: 'list' as const,
    };
    expect(restoreLibraryPreferences(JSON.stringify(saved))).toEqual(saved);
  });
  it('recovers defaults from absent, malformed or unsupported stored values', () => {
    for (const raw of [null, '{broken', 'null', '1', '"grid"', '[]']) {
      expect(restoreLibraryPreferences(raw)).toEqual(DEFAULT_LIBRARY_PREFERENCES);
    }
    expect(
      restoreLibraryPreferences(
        JSON.stringify({
          query: 10,
          source: 'unknown',
          analysis: 'complete',
          sort: 'price',
          layout: 'tiles',
        }),
      ),
    ).toEqual(DEFAULT_LIBRARY_PREFERENCES);
  });
  it('restores supported fields when an older preference format is partial', () => {
    expect(restoreLibraryPreferences('{"layout":"list"}')).toEqual({
      ...DEFAULT_LIBRARY_PREFERENCES,
      layout: 'list',
    });
    expect(
      restoreLibraryPreferences(JSON.stringify({ query: 'a'.repeat(600) })).query,
    ).toHaveLength(500);
  });
  it('clears conditions while retaining selected sorting and layout', () => {
    const selected = {
      ...DEFAULT_LIBRARY_PREFERENCES,
      query: 'bottle',
      analysis: 'analyzed' as const,
      sort: 'title-asc' as const,
      layout: 'list' as const,
    };
    expect(hasLibraryFilters(selected)).toBe(true);
    const cleared = clearLibraryFilters(selected);
    expect(cleared).toEqual({ ...DEFAULT_LIBRARY_PREFERENCES, sort: 'title-asc', layout: 'list' });
    expect(hasLibraryFilters(cleared)).toBe(false);
    expect(selected.query).toBe('bottle');
  });
  it('retains safe definition filters and defaults missing or hostile values', () => {
    const group = '00000000-0000-4000-8000-000000000001';
    expect(restoreLibraryPreferences(JSON.stringify({ group, tag: 'none' }))).toEqual({
      ...DEFAULT_LIBRARY_PREFERENCES,
      group,
      tag: 'none',
    });
    expect(
      restoreLibraryPreferences(JSON.stringify({ group: 'javascript:alert(1)', tag: 8 })),
    ).toEqual(DEFAULT_LIBRARY_PREFERENCES);
    expect(hasLibraryFilters({ ...DEFAULT_LIBRARY_PREFERENCES, group })).toBe(true);
    expect(clearLibraryFilters({ ...DEFAULT_LIBRARY_PREFERENCES, group, tag: 'none' })).toEqual(
      DEFAULT_LIBRARY_PREFERENCES,
    );
  });
});
