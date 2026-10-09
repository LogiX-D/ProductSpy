import type {
  AnalysisEvidence,
  AnalysisOptions,
  Product,
  ProductAnalysis,
} from '@productspy/shared';

export function productFacts(product: Product): Record<string, unknown> {
  return {
    source: product.source,
    sourceId: product.sourceId,
    url: product.url,
    title: product.title.slice(0, 600),
    price: product.price,
    currency: product.currency,
    brand: product.brand,
    rating: product.rating,
    reviewCount: product.reviewCount,
    bulletPoints: product.bulletPoints.slice(0, 12).map((point) => point.slice(0, 1000)),
    description: product.description?.slice(0, 6000),
    textTruncated:
      product.title.length > 600 ||
      (product.description?.length ?? 0) > 6000 ||
      product.bulletPoints.length > 12 ||
      product.bulletPoints.some((point) => point.length > 1000),
    imageCount: product.images.length,
    videoCount: product.videos.length,
    reviewTextCollected: false,
  };
}

const labels = {
  'zh-CN': {
    title: '采集标题',
    brand: '页面品牌',
    price: '页面价格',
    rating: '页面评分',
    count: '页面评论数量',
    claim: '页面宣称',
    unknowns: [
      '未采集真实评论正文，未分析用户评论。',
      '未观看或上传商品图片和视频，未实测功能、质量或效果。',
    ],
  },
  en: {
    title: 'Captured title',
    brand: 'Page brand',
    price: 'Page price',
    rating: 'Page rating',
    count: 'Page review count',
    claim: 'Page claim',
    unknowns: [
      'Actual review text was not collected or analyzed.',
      'Images and videos were not viewed or uploaded; functions, quality and results have not been tested.',
    ],
  },
  ja: {
    title: '取得した商品名',
    brand: 'ページのブランド',
    price: 'ページの価格',
    rating: 'ページの評価',
    count: 'ページのレビュー件数',
    claim: 'ページの主張',
    unknowns: [
      '実際のレビュー本文は収集・分析していません。',
      '画像・動画の閲覧や送信、機能・品質・効果の実測は行っていません。',
    ],
  },
} as const;

/** Facts are derived from captured text, never promoted from generated claims. */
export function capturedEvidence(
  product: Product,
  options: AnalysisOptions,
  analysis: ProductAnalysis,
): AnalysisEvidence {
  const copy = labels[options.language];
  const truncated = productFacts(product).textTruncated;
  const facts = [`${copy.title}: ${product.title.slice(0, 600)}`];
  if (product.brand) facts.push(`${copy.brand}: ${product.brand.slice(0, 600)}`);
  if (product.price) facts.push(`${copy.price}: ${product.price} ${product.currency ?? ''}`.trim());
  if (product.rating !== undefined) facts.push(`${copy.rating}: ${product.rating}`);
  if (product.reviewCount !== undefined) facts.push(`${copy.count}: ${product.reviewCount}`);
  facts.push(
    ...product.bulletPoints.slice(0, 6).map((claim) => `${copy.claim}: ${claim.slice(0, 600)}`),
  );
  return {
    facts,
    inferences: [
      ...analysis.targetAudience,
      ...analysis.painPoints,
      ...analysis.marketingAngles,
    ].slice(0, 30),
    unknowns: [
      ...copy.unknowns,
      ...(truncated
        ? [
            {
              'zh-CN': '为控制请求规模，过长标题、描述或卖点已截断；分析并未覆盖完整原文。',
              en: 'Long titles, descriptions or bullet points were truncated to bound request size; the analysis does not cover all captured text.',
              ja: '送信量を抑えるため長い商品名・説明・箇条書きを省略しました。全文を分析しているわけではありません。',
            }[options.language],
          ]
        : []),
    ],
    reviewTextAnalyzed: false,
  };
}

export function scriptDurations(duration: AnalysisOptions['duration']): string[] {
  const weights = [0, 0.15, 0.35, 0.55, 0.85, 1];
  return weights
    .slice(0, -1)
    .map(
      (weight, index) =>
        `${Math.round(weight * duration)}–${Math.round(weights[index + 1] * duration)}s`,
    );
}
