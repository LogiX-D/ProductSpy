import {
  analysisOptionsSchema,
  comparisonProductsSchema,
  type AnalysisOptions,
  type ComparisonAnalysis,
  type ComparisonGenerationResult,
  type Product,
} from '@productspy/shared';
import { comparisonCapturedEvidence } from './comparison-generation';
import { scriptDurations } from './generation';

export function mockComparison(
  products: Product[],
  inputOptions?: AnalysisOptions,
): ComparisonGenerationResult {
  comparisonProductsSchema.parse(products);
  const options = analysisOptionsSchema.parse(inputOptions ?? {});
  const names = products.map((product) => `${product.sourceId}: ${product.title.slice(0, 160)}`);
  const prices = products.map(
    (product) =>
      `${product.sourceId}: ${product.price ?? '未知 / Unknown'} ${product.currency ?? '未知 / Unknown'}`,
  );
  const times = scriptDurations(options.duration);
  let analysis: ComparisonAnalysis;
  if (options.language === 'en') {
    analysis = {
      coreDifferences: [
        `Mock example for ${options.market} / ${options.platform}: compare captured listings, not live data.`,
        ...names,
        `Historical prices: ${prices.join('; ')}. Different currencies are not ranked or converted.`,
      ],
      verifiableSellingPoints: products.map(
        (p) =>
          `${p.sourceId}: merchant claim — ${p.bulletPoints[0]?.slice(0, 500) ?? 'No bullet points collected'}. Check the exact variant and its specification before using this claim.`,
      ),
      audienceDifferences: products.map(
        (p) =>
          `Hypothesis for ${p.sourceId}: a shopper considering “${p.title.slice(0, 140)}” may compare the listed details against their own use case. Confirm this with real interviews; no customer review text is available.`,
      ),
      opportunities: [
        'Test a side-by-side listing-detail checklist in the selected market. Track responses after publishing a human-verified version; existing demand and conversion are unknown.',
      ],
      contentAngles: [
        `On ${options.platform}, show one shared use case and one page-listed distinction for each ASIN. Use ${options.style} delivery; label untested claims and do not invent results.`,
      ],
      videoRecommendations: [
        `Hook (${times[0]}): “Which listing fits your needs?” Show the product names.\nProblem (${times[1]}): point to one unknown detail rather than a fabricated buyer complaint.\nSolution (${times[2]}): display exact ASIN and one page-listed claim for each product.\nDemo (${times[3]}): shoot a readable checklist of dimensions/materials only after checking the variant; no performance claims.\nCTA (${times[4]}): “Check the current listing and exact variant before choosing.”`,
      ],
      risks: [
        'Mock is a deterministic demonstration, not verified model quality.',
        'Reviews, actual sales, profit, conversion and market share were not collected. Product effects and suitability remain untested.',
        ...(options.customInstructions
          ? [
              `Custom requirement saved: ${options.customInstructions.slice(0, 1000)}. Mock does not interpret arbitrary requirements; a human must verify compliance.`,
            ]
          : []),
      ],
    };
  } else if (options.language === 'ja') {
    analysis = {
      coreDifferences: [
        `Mock サンプル：${options.market} / ${options.platform}。過去の取得情報を比較し、リアルタイム情報とは扱いません。`,
        ...names,
        `取得価格：${prices.join('；')}。異なる通貨の順位や換算は行いません。`,
      ],
      verifiableSellingPoints: products.map(
        (p) =>
          `${p.sourceId}：販売者の主張 — ${p.bulletPoints[0]?.slice(0, 500) ?? '箇条書きは未取得'}。該当バリエーションの仕様を確認してから利用してください。`,
      ),
      audienceDifferences: products.map(
        (p) =>
          `仮説：${p.sourceId}「${p.title.slice(0, 140)}」を検討する人は用途とページの詳細を照合する可能性があります。実際のインタビューで検証が必要です。レビュー本文はありません。`,
      ),
      opportunities: [
        '対象市場でページ詳細の比較チェックリストを試します。需要や購入率は未知であり、公開後の反応で検証してください。',
      ],
      contentAngles: [
        `${options.platform} 向けに共通の利用場面と各 ASIN のページ上の相違点を一つずつ示します。${options.style} の表現でも未検証の効果や使用体験は作りません。`,
      ],
      videoRecommendations: [
        `Hook (${times[0]})：「どちらの仕様が自分に合う？」商品名を映す。\nProblem (${times[1]})：架空の不満ではなく不足情報を示す。\nSolution (${times[2]})：ASIN と販売者の説明を並べる。\nDemo (${times[3]})：バリエーション確認後に寸法・素材のチェックリストを撮影。効果を保証しない。\nCTA (${times[4]})：「最新ページと正確なバリエーションを確認しましょう。」`,
      ],
      risks: [
        'Mock は固定サンプルであり、実際のモデル品質を示しません。',
        'レビュー本文、売上、利益、購入率、市場占有率は未取得です。機能・効果・適合性は未検証です。',
        ...(options.customInstructions
          ? [
              `保存した要望：${options.customInstructions.slice(0, 1000)}。Mock は任意の要望を解釈せず、適合性は人が確認してください。`,
            ]
          : []),
      ],
    };
  } else {
    analysis = {
      coreDifferences: [
        `Mock 示例：${options.market} / ${options.platform}；比较历史页面记录，不代表实时信息。`,
        ...names,
        `页面采集价格：${prices.join('；')}。不同货币不比较高低、不换算。`,
      ],
      verifiableSellingPoints: products.map(
        (p) =>
          `${p.sourceId}：页面宣称「${p.bulletPoints[0]?.slice(0, 500) ?? '未采集卖点，未知'}」。核对对应 ASIN 变体的规格及实测证据后再用于营销。`,
      ),
      audienceDifferences: products.map(
        (p) =>
          `待验证假设：考虑 ${p.sourceId}「${p.title.slice(0, 140)}」的用户可能关注页面列出的细节与使用场景是否相符。需真实访谈验证；没有评论正文依据。`,
      ),
      opportunities: [
        '在目标市场测试同场景的页面细节检查清单。人工核实内容后观察真实响应；当前需求与转化效果未知。',
      ],
      contentAngles: [
        `为 ${options.platform} 拍摄同一使用场景，逐个指出 ${products.map((p) => p.sourceId).join(' / ')} 的一项页面区别。采用 ${options.style} 风格，商家宣称加标签，不虚构实际效果。`,
      ],
      videoRecommendations: [
        `Hook (${times[0]})：「哪款页面规格更符合你的需求？」展示商品名称。\nProblem (${times[1]})：指出一项尚未确认的信息，不编造买家抱怨。\nSolution (${times[2]})：展示各 ASIN 及一项页面宣称。\nDemo (${times[3]})：核对变体后拍摄可读的尺寸、材质清单；不承诺性能效果。\nCTA (${times[4]})：「选择前核对最新商品页和准确变体。」`,
      ],
      risks: [
        'Mock 是固定演示，不代表真实模型质量。',
        '未采集真实评论正文、销量、利润、转化率或市场份额；功能、效果和适用性尚未实测。',
        ...(options.customInstructions
          ? [
              `已保存自定义要求：${options.customInstructions.slice(0, 1000)}。Mock 不理解任意自定义要求，是否遵守需人工检查。`,
            ]
          : []),
      ],
    };
  }
  return {
    analysis,
    evidence: comparisonCapturedEvidence(products, options, analysis),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
