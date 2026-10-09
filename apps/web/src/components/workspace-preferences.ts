import type { Product } from '@productspy/shared';

export const LIBRARY_PREFERENCES_KEY = 'productspy:library-preferences:v1';
export interface LibraryPreferences {
  query: string;
  source: 'all' | 'amazon';
  analysis: 'all' | 'pending' | 'analyzed';
  sort: 'updated-desc' | 'collected-desc' | 'collected-asc' | 'title-asc';
  layout: 'grid' | 'list';
  group: string;
  tag: string;
}
export const DEFAULT_LIBRARY_PREFERENCES: LibraryPreferences = {
  query: '',
  source: 'all',
  analysis: 'all',
  sort: 'updated-desc',
  layout: 'grid',
  group: 'all',
  tag: 'all',
};

/** Local preferences are untrusted and may come from an older app version. */
export function restoreLibraryPreferences(raw: string | null): LibraryPreferences {
  try {
    const value: unknown = raw ? JSON.parse(raw) : undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { ...DEFAULT_LIBRARY_PREFERENCES };
    const stored = value as Record<string, unknown>;
    return {
      query: typeof stored.query === 'string' ? stored.query.slice(0, 500) : '',
      source: stored.source === 'amazon' ? 'amazon' : 'all',
      analysis:
        stored.analysis === 'pending' || stored.analysis === 'analyzed' ? stored.analysis : 'all',
      sort:
        stored.sort === 'collected-desc' ||
        stored.sort === 'collected-asc' ||
        stored.sort === 'title-asc'
          ? stored.sort
          : 'updated-desc',
      layout: stored.layout === 'list' ? 'list' : 'grid',
      group: restoreDefinitionFilter(stored.group),
      tag: restoreDefinitionFilter(stored.tag),
    };
  } catch {
    return { ...DEFAULT_LIBRARY_PREFERENCES };
  }
}

function restoreDefinitionFilter(value: unknown): string {
  return typeof value === 'string' &&
    (value === 'none' || /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value))
    ? value
    : 'all';
}

function timestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export function selectLibraryProducts(
  products: readonly Product[],
  preferences: LibraryPreferences,
): Product[] {
  const term = preferences.query.trim().toLocaleLowerCase();
  return products
    .filter(
      (product) =>
        (preferences.source === 'all' || preferences.source === product.source) &&
        (preferences.analysis === 'all' ||
          (preferences.analysis === 'analyzed'
            ? Boolean(product.aiAnalysis)
            : !product.aiAnalysis)) &&
        (preferences.group === 'all' ||
          (preferences.group === 'none'
            ? !product.groupIds?.length
            : product.groupIds?.includes(preferences.group))) &&
        (preferences.tag === 'all' ||
          (preferences.tag === 'none'
            ? !product.tagIds?.length
            : product.tagIds?.includes(preferences.tag))) &&
        (!term ||
          [product.title, product.brand, product.sourceId].some((value) =>
            value?.toLocaleLowerCase().includes(term),
          )),
    )
    .sort((a, b) => {
      const order =
        preferences.sort === 'title-asc'
          ? a.title.localeCompare(b.title, 'zh-CN', { numeric: true, sensitivity: 'base' })
          : preferences.sort === 'collected-asc'
            ? timestamp(a.createdAt) - timestamp(b.createdAt)
            : preferences.sort === 'collected-desc'
              ? timestamp(b.createdAt) - timestamp(a.createdAt)
              : timestamp(b.updatedAt) - timestamp(a.updatedAt);
      return order || a.id.localeCompare(b.id);
    });
}

export function clearLibraryFilters(preferences: LibraryPreferences): LibraryPreferences {
  return { ...preferences, query: '', source: 'all', analysis: 'all', group: 'all', tag: 'all' };
}

export function hasLibraryFilters(preferences: LibraryPreferences): boolean {
  return Boolean(
    preferences.query ||
    preferences.source !== 'all' ||
    preferences.analysis !== 'all' ||
    preferences.group !== 'all' ||
    preferences.tag !== 'all',
  );
}

export const LIBRARY_PAGE_SIZE = 36;
export function paginateLibraryProducts(products: readonly Product[], page: number) {
  const totalPages = Math.max(1, Math.ceil(products.length / LIBRARY_PAGE_SIZE));
  const currentPage = Math.min(totalPages, Math.max(1, Math.trunc(page) || 1));
  const offset = (currentPage - 1) * LIBRARY_PAGE_SIZE;
  return { products: products.slice(offset, offset + LIBRARY_PAGE_SIZE), currentPage, totalPages };
}
