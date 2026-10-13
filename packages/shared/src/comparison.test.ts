import { describe, expect, it } from 'vitest';
import { mergeProduct } from './product';
import {
  comparisonAnalysisSchema,
  comparisonBackupSchema,
  comparisonEvidenceSchema,
  comparisonPlanSchema,
  comparisonRows,
  exportComparisonCsv,
  exportComparisonMarkdown,
  type ComparisonAnalysis,
  type ComparisonPlan,
} from './comparison';

const products = ['B012345678', 'B012345679'].map((sourceId, index) =>
  mergeProduct({
    source: 'amazon',
    sourceId,
    url: `https://www.amazon.${index ? 'co.jp' : 'com'}/dp/${sourceId}`,
    title: index ? 'Bottle B' : '=HYPERLINK("https://invalid")',
    price: index ? '￥2000' : '$25',
    currency: index ? 'JPY' : 'USD',
    images: [],
    videos: [],
    bulletPoints: index ? [] : ['Page-listed steel'],
  }),
);
const analysis: ComparisonAnalysis = {
  coreDifferences: ['Different page titles'],
  verifiableSellingPoints: ['Merchant claim; check the variant'],
  audienceDifferences: ['Hypothesis, validate'],
  opportunities: ['Test a checklist'],
  contentAngles: ['Show details'],
  videoRecommendations: ['Hook: compare exact variants'],
  risks: ['No review text'],
};
const plan: ComparisonPlan = {
  id: '12345678-1234-4234-8234-123456789012',
  name: 'Bottle | comparison',
  products,
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
  analysis,
};
describe('comparison schema and export boundaries', () => {
  it('requires 2–5 unique snapshots and retains original product IDs', () => {
    expect(comparisonPlanSchema.parse(plan).products.map((p) => p.id)).toEqual(
      products.map((p) => p.id),
    );
    expect(comparisonPlanSchema.safeParse({ ...plan, products: [products[0]] }).success).toBe(
      false,
    );
    expect(
      comparisonPlanSchema.safeParse({ ...plan, products: [products[0], products[0]] }).success,
    ).toBe(false);
    expect(
      comparisonPlanSchema.safeParse({ ...plan, products: [...products, ...products, ...products] })
        .success,
    ).toBe(false);
  });
  it('rejects incomplete AI fields, extra claims and review analysis impersonation', () => {
    expect(comparisonAnalysisSchema.safeParse({ ...analysis, coreDifferences: [] }).success).toBe(
      false,
    );
    expect(comparisonAnalysisSchema.safeParse({ ...analysis, sales: ['500'] }).success).toBe(false);
    const evidence = {
      facts: [],
      merchantClaims: [],
      inferences: [],
      unknowns: [],
      reviewTextAnalyzed: false,
    };
    expect(comparisonEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(
      comparisonEvidenceSchema.safeParse({ ...evidence, reviewTextAnalyzed: true }).success,
    ).toBe(false);
  });
  it('shows unknown missing fields, historical currencies without numeric price ranking', () => {
    const rows = comparisonRows(products);
    expect(rows.find((row) => row.key === 'brand')?.values).toEqual(['未知', '未知']);
    expect(rows.find((row) => row.key === 'currency')).toMatchObject({
      different: true,
      values: ['USD', 'JPY'],
    });
    expect(rows.find((row) => row.key === 'country')?.values).toEqual(['美国 (US)', '日本 (JP)']);
    expect(rows.find((row) => row.key === 'price')?.label).toContain('非实时');
    expect(rows.find((row) => row.key === 'specifications')?.values[0]).toContain('未知');
  });
  it('counts unique primary image and labels merchant-provided specifications', () => {
    const product = {
      ...products[0]!,
      mainImage: 'https://m.media-amazon.com/a.jpg',
      images: ['https://m.media-amazon.com/b.jpg', 'https://m.media-amazon.com/b.jpg'],
      specifications: [{ name: 'Material', value: 'steel', source: 'page' as const }],
    };
    expect(comparisonRows([product]).find((row) => row.key === 'images')?.values).toEqual(['2']);
    expect(comparisonRows([product]).find((row) => row.key === 'specifications')?.label).toContain(
      '商家信息',
    );
  });
  it('escapes CSV formulas and Markdown table syntax without inventing data', () => {
    expect(exportComparisonCsv(plan)).toContain("'=HYPERLINK");
    const markdown = exportComparisonMarkdown(plan);
    expect(markdown).toContain('Bottle \\| comparison');
    expect(markdown).toContain('不同货币不排序、不换算');
    expect(markdown).toContain('Mock');
    expect(markdown).toContain('未知');
  });
  it('rejects unexpected backup fields and duplicate plan identifiers', () => {
    const backup = {
      format: 'productspy-comparisons',
      schemaVersion: 1,
      exportedAt: plan.createdAt,
      plans: [plan],
    };
    expect(comparisonBackupSchema.safeParse(backup).success).toBe(true);
    expect(comparisonBackupSchema.safeParse({ ...backup, key: 'private' }).success).toBe(false);
    expect(
      comparisonBackupSchema.safeParse({
        ...backup,
        plans: [
          { ...plan, products: [{ ...products[0], privateKey: 'unexpected-field' }, products[1]] },
        ],
      }).success,
    ).toBe(false);
    expect(comparisonBackupSchema.safeParse({ ...backup, plans: [plan, plan] }).success).toBe(
      false,
    );
  });
});
