import type { Product, ProductDraft } from './types';

export function productKey(draft: Pick<ProductDraft, 'source' | 'sourceId'>): string {
  return `${draft.source}:${draft.sourceId.toUpperCase()}`;
}
export function mergeProduct(
  draft: ProductDraft,
  existing?: Product,
  now = new Date().toISOString(),
): Product {
  const updatedAt = new Date(
    Math.max(Date.parse(now), existing ? Date.parse(existing.updatedAt) + 1 : 0),
  ).toISOString();
  const normalized = {
    ...draft,
    sourceId: draft.sourceId.toUpperCase(),
    images: [...new Set(draft.images)],
    bulletPoints: [...new Set(draft.bulletPoints)],
  };
  const changed =
    existing &&
    ['title', 'price', 'brand', 'description', 'bulletPoints'].some(
      (field) =>
        JSON.stringify(existing[field as keyof Product]) !==
        JSON.stringify(normalized[field as keyof ProductDraft]),
    );
  return {
    ...normalized,
    id: existing?.id ?? productKey(normalized),
    createdAt: existing?.createdAt ?? now,
    updatedAt,
    aiAnalysis: changed ? undefined : existing?.aiAnalysis,
    analysisMetadata: changed ? undefined : existing?.analysisMetadata,
    analysisHistory: existing?.analysisHistory,
    ...(existing?.groupIds ? { groupIds: existing.groupIds } : {}),
    ...(existing?.tagIds ? { tagIds: existing.tagIds } : {}),
  };
}
export function errorMessage(error: unknown, fallback = '操作失败，请重试'): string {
  return error instanceof Error ? error.message : fallback;
}
