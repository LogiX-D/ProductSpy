import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentReferenceStatus, productAnalysisReference } from './content-references';
import { contentOptionsSchema, contentPlanSchema } from './content';
import { builtinTemplates } from './templates';
import { mergeProduct } from './product';
const product = mergeProduct({
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Stored listing',
  price: '$25',
  currency: 'USD',
  images: [],
  videos: [],
  bulletPoints: ['Merchant claim'],
});
const template = builtinTemplates[0]!;
const plan = contentPlanSchema.parse({
  id: randomUUID(),
  name: 'Archived plan',
  productId: product.id,
  productSnapshot: product,
  templateSnapshot: template,
  options: contentOptionsSchema.parse({}),
  status: 'draft',
  favorite: false,
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
  versions: [],
});
const analysis = {
  summary: 'Hypothesis',
  sellingPoints: ['claim'],
  targetAudience: ['audience'],
  purchaseMotivations: ['motivation'],
  painPoints: ['pain'],
  strengths: ['strength'],
  weaknesses: ['unknown'],
  marketingAngles: ['angle'],
  hooks: ['a', 'b', 'c', 'd', 'e'],
  shortVideoScript: 'draft',
  imagePrompts: ['image draft'],
  videoPrompts: ['video draft'],
};
describe('immutable cross-module content references', () => {
  it('does not falsely mark a source stale after group/tag, favorite, identical recapture or history housekeeping', () => {
    const result = contentReferenceStatus(plan, {
      product: {
        ...product,
        updatedAt: '2026-10-14T00:00:00.000Z',
        groupIds: [randomUUID()],
        tagIds: [randomUUID()],
      },
      template: { ...template, favorite: true, updatedAt: '2026-10-14T00:00:00.000Z' },
    });
    expect(result.product.status).toBe('unchanged');
    expect(result.template.status).toBe('unchanged');
    expect(result.productAnalysis.status).toBe('not-referenced');
    expect(result.canCreateLatest).toBe(true);
  });
  it('distinguishes changed captured facts from newly saved AI analysis', () => {
    const facts = contentReferenceStatus(plan, { product: { ...product, price: '$30' }, template });
    expect(facts.product.status).toBe('updated');
    expect(facts.productAnalysis.status).toBe('not-referenced');
    const ai = contentReferenceStatus(plan, {
      product: { ...product, aiAnalysis: analysis },
      template,
    });
    expect(ai.product.status).toBe('unchanged');
    expect(ai.productAnalysis.status).toBe('updated');
    expect(plan.productSnapshot.aiAnalysis).toBeUndefined();
  });
  it('preserves snapshots after deletion and refuses a live product with another ASIN', () => {
    const deleted = contentReferenceStatus(plan, { template });
    expect(deleted.product.status).toBe('deleted');
    expect(deleted.canCreateLatest).toBe(false);
    const mismatch = contentReferenceStatus(plan, {
      product: { ...product, sourceId: 'B012345679' },
      template,
    });
    expect(mismatch.product.status).toBe('identity-mismatch');
    expect(mismatch.canCreateLatest).toBe(false);
    expect(plan.productSnapshot.sourceId).toBe('B012345678');
  });
  it('marks template definition updates but ignores unchanged names from history restoration', () => {
    expect(
      contentReferenceStatus(plan, { product, template: { ...template, prompt: 'New direction' } })
        .template.status,
    ).toBe('updated');
    expect(contentReferenceStatus(plan, { product }).template.status).toBe('deleted');
  });
  it('reports changed or deleted comparison source without mutating the original source', () => {
    const comparison = {
      id: randomUUID(),
      name: 'Historical comparison',
      products: [
        product,
        {
          ...product,
          id: randomUUID(),
          sourceId: 'B012345679',
          url: 'https://www.amazon.com/dp/B012345679',
        },
      ],
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      analysis: {
        coreDifferences: ['difference'],
        verifiableSellingPoints: ['claim'],
        audienceDifferences: ['hypothesis'],
        opportunities: ['opportunity'],
        contentAngles: ['angle'],
        videoRecommendations: ['demo'],
        risks: ['unknown'],
      },
    };
    const linked = { ...plan, comparisonSource: comparison };
    expect(
      contentReferenceStatus(linked, {
        product,
        template,
        comparison: { ...comparison, name: 'Renamed', updatedAt: '2026-10-14T00:00:00.000Z' },
      }).comparison?.status,
    ).toBe('unchanged');
    expect(
      contentReferenceStatus(linked, {
        product,
        template,
        comparison: {
          ...comparison,
          analysis: { ...comparison.analysis, coreDifferences: ['new difference'] },
        },
      }).comparison?.status,
    ).toBe('updated');
    expect(contentReferenceStatus(linked, { product, template }).comparison?.status).toBe(
      'deleted',
    );
    expect(linked.comparisonSource.analysis.coreDifferences).toEqual(['difference']);
  });
  it('provides legacy provenance without inventing a generated version', () => {
    const withAnalysis = { ...product, aiAnalysis: analysis };
    expect(productAnalysisReference(withAnalysis)).toMatchObject({
      productId: product.id,
      asin: product.sourceId,
      mode: 'legacy',
      classification: 'saved-analysis-unverified',
    });
    expect(productAnalysisReference(product)).toBeUndefined();
  });
});
