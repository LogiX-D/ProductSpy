import { z } from 'zod';
import type { Product } from './types';
import type { ContentMetadata, ContentPlan } from './content';
import { templateDefinition, type AITemplate } from './templates';
import type { ComparisonPlan } from './comparison';

const referenceSchema = z
  .object({
    id: z.string().min(1).max(100),
    status: z.enum(['unchanged', 'updated', 'deleted', 'identity-mismatch', 'not-referenced']),
    capturedAt: z.string().datetime().optional(),
    latestAt: z.string().datetime().optional(),
  })
  .strict();
export const contentReferenceStatusSchema = z
  .object({
    product: referenceSchema,
    productAnalysis: referenceSchema,
    template: referenceSchema,
    comparison: referenceSchema.optional(),
    canCreateLatest: z.boolean(),
  })
  .strict();
export type ContentReferenceStatus = z.infer<typeof contentReferenceStatusSchema>;

/** Only page capture fields: library organization, AI writes and recapture timestamps are not changes in captured facts. */
export function productCaptureSignature(product: Product): string {
  return JSON.stringify([
    product.source,
    product.sourceId,
    product.url,
    product.title,
    product.price,
    product.currency,
    product.brand,
    product.rating,
    product.reviewCount,
    product.mainImage,
    product.images,
    product.videos,
    product.bulletPoints,
    product.description,
    product.specifications ?? [],
    product.mediaMetadata?.map(({ url, kind, sourceUrl, productSourceId, width, height }) => [
      url,
      kind,
      sourceUrl,
      productSourceId,
      width,
      height,
    ]) ?? [],
  ]);
}
export function productAnalysisReference(
  product: Product,
): ContentMetadata['productAnalysisReference'] {
  if (!product.aiAnalysis) return undefined;
  const latest = product.analysisHistory?.at(-1);
  return {
    productId: product.id,
    asin: product.sourceId,
    ...(latest?.id ? { versionId: latest.id } : {}),
    mode: latest?.kind === 'edited' ? 'edited' : (product.analysisMetadata?.mode ?? 'legacy'),
    sourceUpdatedAt: product.analysisMetadata?.sourceUpdatedAt ?? product.updatedAt,
    classification: 'saved-analysis-unverified',
  };
}
function analysisSignature(product: Product): string {
  return JSON.stringify([product.aiAnalysis ?? null, product.analysisMetadata ?? null]);
}
function comparisonSignature(plan: ComparisonPlan): string {
  return JSON.stringify([
    plan.products.map(productCaptureSignature),
    plan.analysis ?? null,
    plan.analysisMetadata ?? null,
  ]);
}
/** Read-only comparison; deleting or updating sources never mutates an archived content plan. */
export function contentReferenceStatus(
  plan: ContentPlan,
  live: {
    product?: Product;
    template?: AITemplate;
    comparison?: ComparisonPlan;
  },
): ContentReferenceStatus {
  const sameIdentity =
    live.product &&
    live.product.id === plan.productId &&
    live.product.source === plan.productSnapshot.source &&
    live.product.sourceId === plan.productSnapshot.sourceId;
  const productStatus = !live.product
    ? 'deleted'
    : !sameIdentity
      ? 'identity-mismatch'
      : productCaptureSignature(plan.productSnapshot) === productCaptureSignature(live.product)
        ? 'unchanged'
        : 'updated';
  const hasAnalysis = Boolean(plan.productSnapshot.aiAnalysis);
  const productAnalysis = !live.product
    ? 'deleted'
    : !sameIdentity
      ? 'identity-mismatch'
      : analysisSignature(plan.productSnapshot) === analysisSignature(live.product)
        ? hasAnalysis
          ? 'unchanged'
          : 'not-referenced'
        : 'updated';
  const templateStatus = !live.template
    ? 'deleted'
    : JSON.stringify({ ...templateDefinition(plan.templateSnapshot), favorite: false }) ===
        JSON.stringify({ ...templateDefinition(live.template), favorite: false })
      ? 'unchanged'
      : 'updated';
  return contentReferenceStatusSchema.parse({
    product: {
      id: plan.productId,
      status: productStatus,
      capturedAt: plan.productSnapshot.updatedAt,
      latestAt: live.product?.updatedAt,
    },
    productAnalysis: {
      id: plan.productId,
      status: productAnalysis,
      capturedAt: plan.productSnapshot.analysisMetadata?.generatedAt,
      latestAt: live.product?.analysisMetadata?.generatedAt,
    },
    template: {
      id: plan.templateSnapshot.id,
      status: templateStatus,
      capturedAt: plan.templateSnapshot.updatedAt,
      latestAt: live.template?.updatedAt,
    },
    ...(plan.comparisonSource
      ? {
          comparison: {
            id: plan.comparisonSource.id,
            status: !live.comparison
              ? 'deleted'
              : comparisonSignature(plan.comparisonSource) === comparisonSignature(live.comparison)
                ? 'unchanged'
                : 'updated',
            capturedAt: plan.comparisonSource.updatedAt,
            latestAt: live.comparison?.updatedAt,
          },
        }
      : {}),
    canCreateLatest: Boolean(sameIdentity && live.template),
  });
}
