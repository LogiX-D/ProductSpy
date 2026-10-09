import { describe, expect, it } from 'vitest';
import {
  analysisEvidenceSchema,
  analysisOptionsSchema,
  analysisPricingSchema,
  analysisUsageSchema,
  DEFAULT_ANALYSIS_OPTIONS,
  MAX_ANALYSIS_VERSIONS,
  productSchema,
} from './schema';

describe('Phase 12 shared contract and old data', () => {
  it('fills predictable preferences and rejects unsupported values and oversized instructions', () => {
    expect(analysisOptionsSchema.parse({})).toEqual(DEFAULT_ANALYSIS_OPTIONS);
    expect(analysisOptionsSchema.safeParse({ duration: 45 }).success).toBe(false);
    expect(analysisOptionsSchema.safeParse({ language: 'fr' }).success).toBe(false);
    expect(analysisOptionsSchema.safeParse({ customInstructions: 'x'.repeat(4001) }).success).toBe(
      false,
    );
    expect(analysisOptionsSchema.parse({ market: 'JP', language: 'ja', duration: 15 }).market).toBe(
      'JP',
    );
  });
  it('reads v0.3.0 Product without manufacturing new metadata or history', () => {
    const old = {
      id: 'amazon:B012345678',
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Legacy product',
      images: [],
      videos: [],
      bulletPoints: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(productSchema.parse(old)).toEqual(old);
    expect('analysisHistory' in productSchema.parse(old)).toBe(false);
    expect(MAX_ANALYSIS_VERSIONS).toBe(50);
  });
  it('cannot declare review text was analyzed when it was never collected', () => {
    const evidence = {
      facts: [],
      inferences: [],
      unknowns: ['No review text'],
      reviewTextAnalyzed: false,
    };
    expect(analysisEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(
      analysisEvidenceSchema.safeParse({ ...evidence, reviewTextAnalyzed: true }).success,
    ).toBe(false);
  });
  it('distinguishes unknown usage from measured zero and rejects unsafe cost values', () => {
    expect(analysisUsageSchema.parse({ costEstimated: false })).not.toHaveProperty('costUsd');
    expect(
      analysisUsageSchema.parse({
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        costEstimated: true,
      }).costUsd,
    ).toBe(0);
    expect(analysisPricingSchema.safeParse({ inputUsdPerMillion: 1 }).success).toBe(false);
    expect(
      analysisPricingSchema.safeParse({ inputUsdPerMillion: -1, outputUsdPerMillion: 1 }).success,
    ).toBe(false);
    expect(analysisUsageSchema.safeParse({ costUsd: Infinity, costEstimated: true }).success).toBe(
      false,
    );
  });
});
