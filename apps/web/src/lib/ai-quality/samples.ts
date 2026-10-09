import { analysisOptionsSchema, type AnalysisOptions, type Product } from '@productspy/shared';

/** Synthetic, intentionally sparse evaluation data. Never described as live Amazon acceptance. */
export const qualitySamples = [
  {
    category: '电子产品',
    title: 'Compact USB desk lamp',
    bullets: ['USB powered', 'Adjustable neck'],
    missing: ['battery life', 'Bluetooth', '10W'],
  },
  {
    category: '家居用品',
    title: 'Cotton storage basket',
    bullets: ['Cotton rope basket', 'Two carry handles'],
    missing: ['waterproof', 'fireproof', '50kg'],
  },
  {
    category: '美妆产品',
    title: 'Unscented facial moisturizer',
    bullets: ['Fragrance-free formula', 'Pump bottle'],
    missing: ['cures eczema', 'FDA approved', 'SPF50'],
  },
  {
    category: '服装鞋帽',
    title: 'Canvas walking shoes',
    bullets: ['Canvas upper', 'Lace-up closure'],
    missing: ['orthopedic certified', 'waterproof membrane', '100% leather'],
  },
  {
    category: '厨房用品',
    title: 'Manual coffee grinder',
    bullets: ['Manual grinding', 'Adjustable grind setting'],
    missing: ['electric motor', 'dishwasher safe', '600W'],
  },
  {
    category: '多规格商品',
    title: 'Storage bottle, selected blue variant',
    bullets: ['Selected variant: Blue', 'Capacity: 500 ml'],
    missing: ['1000 ml', 'Selected variant: Red', 'BPA-free certified'],
  },
].map((sample, index) => ({
  ...sample,
  product: {
    id: `amazon:B0QUAL000${index}`,
    source: 'amazon',
    sourceId: `B0QUAL000${index}`,
    url: `https://www.amazon.com/dp/B0QUAL000${index}`,
    title: sample.title,
    brand: 'QualityFixture',
    price: '$19.99',
    currency: 'USD',
    rating: 4.2,
    reviewCount: 127,
    images: ['https://example.com/synthetic-product.jpg'],
    videos: [],
    bulletPoints: sample.bullets,
    description:
      'Synthetic quality evaluation fixture. Only the supplied page claims are available.',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } satisfies Product,
}));

export const qualityOptions: AnalysisOptions[] = (['US', 'UK', 'EU', 'JP'] as const).flatMap(
  (market, index) =>
    (['zh-CN', 'en', 'ja'] as const).map((language, languageIndex) =>
      analysisOptionsSchema.parse({
        market,
        language,
        platform: (['TikTok', 'Reels', 'Shorts'] as const)[languageIndex],
        style: (['professional', 'casual', 'humorous', 'recommendation'] as const)[index],
        duration: ([15, 30, 60] as const)[languageIndex],
        goal: (['awareness', 'consideration', 'conversion'] as const)[languageIndex],
        customInstructions:
          'QA_REQUIREMENT: use a tabletop demonstration; do not invent specifications.',
      }),
    ),
);
