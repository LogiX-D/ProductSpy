import {
  analysisSchema,
  analysisOptionsSchema,
  type AIGenerationResult,
  type AIProvider,
  type AnalysisOptions,
  type Product,
  type ProductAnalysis,
  type ComparisonGenerationResult,
  type ContentPlan,
  type ContentOptions,
  type ContentField,
  type ContentGenerationResult,
} from '@productspy/shared';
import { capturedEvidence, scriptDurations } from './generation';
import { mockComparison } from './comparison-mock';
import { mockContent } from './content-generation';

const markets = {
  'zh-CN': { US: '美国', UK: '英国', EU: '欧洲', JP: '日本' },
  en: { US: 'United States', UK: 'United Kingdom', EU: 'Europe', JP: 'Japan' },
  ja: { US: '米国', UK: '英国', EU: '欧州', JP: '日本' },
} as const;
const styles = {
  'zh-CN': {
    professional: '专业：核查细节、客观说明',
    casual: '生活化：具体场景、自然口语',
    humorous: '幽默：轻松反问，不夸张功效',
    recommendation: '种草：展示细节，不伪造体验或评价',
  },
  en: {
    professional: 'professional: check details and explain objectively',
    casual: 'casual: one everyday scene and natural speech',
    humorous: 'humorous: a light question without exaggerated results',
    recommendation: 'recommendation: show details without invented testimonials',
  },
  ja: {
    professional: '専門的：仕様を確認し客観的に説明',
    casual: '日常的：具体的な場面と自然な言葉',
    humorous: 'ユーモア：効果を誇張せず軽い問いかけ',
    recommendation: 'おすすめ：架空の使用体験や口コミを作らず細部を紹介',
  },
} as const;
const goals = {
  'zh-CN': {
    awareness: '认知：先看清商品与用途',
    consideration: '考虑：核查细节与需求是否匹配',
    conversion: '转化：确认规格后查看商品页，不催促或承诺结果',
  },
  en: {
    awareness: 'awareness: identify the product and intended use',
    consideration: 'consideration: check the details against a real need',
    conversion:
      'conversion: review the listing after checking specifications, without pressure or guaranteed outcomes',
  },
  ja: {
    awareness: '認知：商品と用途を把握',
    consideration: '比較検討：自分の必要条件と仕様を照合',
    conversion: '購入検討：仕様確認後に商品ページへ。購入を急かしたり結果を保証しない',
  },
} as const;

function scenario(product: Product, language: AnalysisOptions['language']): string {
  const text = `${product.title} ${product.bulletPoints.join(' ')}`.toLowerCase();
  const groups: [RegExp, string, string, string][] = [
    [
      /serum|moisturi|skin|beauty|cerave|美容|护肤/,
      '梳妆台上核查护肤品页面成分和使用说明',
      'checking skincare listing ingredients and instructions at a dressing table',
      '洗面台でスキンケアの成分表示と使用方法を確認する場面',
    ],
    [
      /pan|kitchen|grinder|coffee|cook|厨房/,
      '厨房台面上检查尺寸、材质和实际操作步骤',
      'checking dimensions, material and real operating steps on a kitchen counter',
      'キッチンで寸法・素材・実際の操作手順を確認する場面',
    ],
    [
      /shoe|sneaker|shirt|dress|apparel|服装|鞋/,
      '衣柜旁核查尺码、面料与实际穿着需求',
      'checking size, fabric and fit needs beside a wardrobe',
      'クローゼットでサイズ・生地・着用条件を確認する場面',
    ],
    [
      /headphone|speaker|charger|electronic|keyboard|电子/,
      '桌面上核查接口、兼容性与已采集规格',
      'checking connectors, compatibility and captured specifications on a desk',
      '机の上で端子・互換性・取得した仕様を確認する場面',
    ],
    [
      /bottle|travel|backpack|水杯/,
      '出门前在桌上核查商品细节与携带需求',
      'checking product details and carrying needs on a table before going out',
      '外出前に机の上で商品仕様と持ち運びの条件を確認する場面',
    ],
    [
      /home|lamp|organizer|storage|家居/,
      '家中实际空间核查尺寸与摆放位置',
      'checking dimensions and placement in an actual home space',
      '自宅の設置場所と寸法を確認する場面',
    ],
  ];
  const selected = groups.find(([expression]) => expression.test(text));
  if (selected) return selected[language === 'zh-CN' ? 1 : language === 'en' ? 2 : 3];
  return {
    'zh-CN': '桌面上逐项核查商品说明和实际需求',
    en: 'checking listing details against a real need on a table',
    ja: '机の上で商品説明と必要条件を一つずつ照合する場面',
  }[language];
}

export class MockAIProvider implements AIProvider {
  async createContent(
    plan: ContentPlan,
    options?: ContentOptions,
    selectedFields?: ContentField[],
  ): Promise<ContentGenerationResult> {
    return mockContent(plan, options, selectedFields);
  }
  async compare(
    products: Product[],
    options?: AnalysisOptions,
  ): Promise<ComparisonGenerationResult> {
    return mockComparison(products, options);
  }
  async analyze(product: Product, options?: AnalysisOptions): Promise<ProductAnalysis> {
    return (await this.generate(product, options)).analysis;
  }

  async generate(product: Product, inputOptions?: AnalysisOptions): Promise<AIGenerationResult> {
    const options = analysisOptionsSchema.parse(inputOptions ?? {});
    const title = product.title.slice(0, 240);
    const market = markets[options.language][options.market];
    const style = styles[options.language][options.style];
    const goal = goals[options.language][options.goal];
    const setting = scenario(product, options.language);
    const timing = scriptDurations(options.duration);
    const claims = product.bulletPoints
      .filter((point) => point.trim())
      .slice(0, 6)
      .map(
        (point) =>
          `${{ 'zh-CN': '页面宣称', en: 'Page claim', ja: 'ページの主張' }[options.language]}: ${point.slice(0, 600)}`,
      );
    const context = `${market} · ${options.platform} · ${options.duration}s · ${style} · ${goal}`;
    let analysis: ProductAnalysis;
    if (options.language === 'en') {
      analysis = {
        summary: `Mock demo analysis: ${title}. ${context}. This is a deterministic local template, not a real model result. Audience, needs and creative angles are hypotheses; product performance has not been tested.`,
        sellingPoints: claims.length
          ? claims
          : [
              'Specific selling points were not captured. Verify specifications and intended use before making claims.',
            ],
        targetAudience: [
          `People in ${market} comparing ${title} with alternatives (hypothesis; validate with interviews).`,
          `Buyers researching ${setting} (hypothesis).`,
        ],
        purchaseMotivations: [
          `Check whether ${title} meets an actual need.`,
          'Compare the captured claims and unresolved details before a purchase.',
        ],
        painPoints: [
          'Scattered listing details make comparisons difficult (hypothesis).',
          'A buyer may be uncertain about fit or compatibility; confirm the actual requirement instead of inventing a limitation.',
        ],
        strengths: [
          `The source and ASIN are available for checking the listing. ${product.images.length} image URLs were captured, but no images were viewed by a model.`,
          ...(claims.length
            ? ['Captured seller statements provide a concrete checklist, not proof of quality.']
            : []),
        ],
        weaknesses: [
          'Quality, durability and performance have not been independently verified.',
          ...(!claims.length ? ['Bullet Points were not captured.'] : []),
          ...(!product.price
            ? ['Price was not captured; value for money cannot be assessed.']
            : []),
          'Actual review text was not collected. A rating or review count is not review analysis.',
          `Local market suitability in ${market} needs verification; no certification or compliance claim is established.`,
        ],
        marketingAngles: [
          `Scene: ${setting}; show ${title} and one captured claim without inventing the result.`,
          `Detail check: ${claims[0] ?? 'ask which missing specification must be verified first'}.`,
          `Decision checklist for ${market}: clarify fit, listing details and unanswered questions. Goal: ${goal}.`,
        ],
        hooks: [
          `Considering ${title}? Check one detail before you decide.`,
          `Does ${title} fit your actual needs? Start with the listing.`,
          'Too many product claims? Let us make a short checklist.',
          `For ${setting}, what should you check first?`,
          'Before buying, separate the listed facts from the unanswered questions.',
          options.style === 'humorous'
            ? 'A product page longer than your shopping list? Start with one detail.'
            : 'Show the real product, check the details, and then decide.',
        ],
        shortVideoScript: [
          `Hook: [${timing[0]}] Close shot of ${title}; voice: “Considering this? Check one detail first.”`,
          `Problem: [${timing[1]}] Show ${setting}; voice: “The listing has a lot to say. Which detail matches your needs?”`,
          `Solution: [${timing[2]}] Show the listing alongside the actual product; voice: “Start with the captured description.” ${claims[0] ?? 'Specific functions remain unconfirmed; do not demonstrate a promised result.'}`,
          `Demo: [${timing[3]}] Film real dimensions, appearance or an independently verified action. Label untested features “to verify”. ${style}.`,
          `CTA: [${timing[4]}] Voice: “Check the full listing and your requirements before deciding.” Goal: ${goal}.`,
        ].join('\n\n'),
        imagePrompts: [
          `Create a vertical concept storyboard for ${title} in ${setting}, intended for ${options.platform} in ${market}. Neutral light, true product proportions and clean detail shots. Use real reference materials during production; none have been uploaded. Do not invent accessories, labels, certifications or effects.`,
        ],
        videoPrompts: [
          `Plan a ${options.duration}-second 9:16 ${options.platform} video for ${title}: opening ${timing[0]}, problem ${timing[1]}, listing check ${timing[2]}, real demonstration ${timing[3]}, CTA ${timing[4]}. Style: ${style}. Use actual references and verified functions; no fake testimonials, guaranteed results or before/after effects.`,
        ],
      };
    } else if (options.language === 'ja') {
      analysis = {
        summary: `Mock デモ分析：${title}。${context}。これは本機の定型デモで、実際のモデル出力ではありません。想定ユーザー・課題・訴求は仮説で、商品の性能は実測していません。`,
        sellingPoints: claims.length
          ? claims
          : ['具体的な訴求点を取得できていません。仕様と使用条件を確認してください。'],
        targetAudience: [
          `${market}で${title}を比較している人（仮説。インタビューで要確認）。`,
          `${setting}を検討する人（仮説）。`,
        ],
        purchaseMotivations: [
          `${title}が実際の必要条件に合うか確認する。`,
          '取得した説明と不明点を比較してから購入を検討する。',
        ],
        painPoints: [
          '商品説明が分散し、比較しにくい可能性（仮説）。',
          '適合性が分からない可能性。実際の条件を確認し、架空の欠点は作らない。',
        ],
        strengths: [
          `商品URLとASINを確認に利用できます。画像URLは${product.images.length}件取得しましたが、モデルは画像を閲覧していません。`,
          ...(claims.length
            ? ['販売者の説明を確認リストに利用できます。品質の証明ではありません。']
            : []),
        ],
        weaknesses: [
          '品質・耐久性・効果を実測していません。',
          ...(!claims.length ? ['Bullet Pointsを取得できていません。'] : []),
          ...(!product.price ? ['価格を取得できていないため、価格競争力は判断できません。'] : []),
          'レビュー本文は収集・分析していません。評価や件数は口コミの結論ではありません。',
          `${market}での適合性は要確認。認証や法令適合を保証しません。`,
        ],
        marketingAngles: [
          `場面：${setting}。${title}と取得した説明を示し、結果は捏造しない。`,
          `細部確認：${claims[0] ?? '不足している仕様を先に確認する。'}`,
          `${market}向けの検討リスト：必要条件・仕様・不明点を整理。目的：${goal}。`,
        ],
        hooks: [
          `${title}を検討中ですか？まず一つの条件を確認。`,
          `${title}は自分の用途に合う？商品説明から確かめよう。`,
          '説明が多くて迷うときは、短い確認リストに。',
          `${setting}なら、何を先に確認する？`,
          '購入前に、分かっている情報と不明点を分けよう。',
          options.style === 'humorous'
            ? '買い物リストより長い商品説明？一つずつ確認しよう。'
            : '実物と説明を確認してから、自分に合うか考えよう。',
        ],
        shortVideoScript: [
          `Hook: [${timing[0]}] ${title}の近接撮影。声：「検討中ですか？まず一つの条件を確認。」`,
          `Problem: [${timing[1]}] ${setting}。声：「説明が多いと、自分に必要な情報が分かりにくいですね。」`,
          `Solution: [${timing[2]}] 実物と商品説明を並べる。声：「取得した説明から確認しましょう。」 ${claims[0] ?? '具体的な機能は要確認。未確認の効果は示さない。'}`,
          `Demo: [${timing[3]}] 実物の外観・寸法・確認済みの操作を撮影。未実測の機能は「要確認」と表示。${style}。`,
          `CTA: [${timing[4]}] 声：「商品ページと必要条件を確認してから検討しましょう。」目的：${goal}。`,
        ].join('\n\n'),
        imagePrompts: [
          `${title}を${setting}で紹介する縦型コンセプト画像。対象：${market}の${options.platform}。自然光、実物の形状と比率、明瞭な細部。制作時に実際の資料を参照する。モデルには素材を送っていない。架空の付属品・認証・効果は追加しない。`,
        ],
        videoPrompts: [
          `${title}の${options.duration}秒・9:16・${options.platform}動画。導入${timing[0]}、課題${timing[1]}、説明確認${timing[2]}、実演${timing[3]}、案内${timing[4]}。${style}。実物の資料と確認済みの機能を使い、架空の口コミや効果比較を作らない。`,
        ],
      };
    } else {
      analysis = {
        summary: `Mock 演示分析：${title}。${context}。这是本机模板演示，未调用真实 AI。以下受众、需求、痛点和营销方向为待验证的创意假设；未验证商品功效。`,
        sellingPoints: claims.length
          ? claims
          : ['商品卖点尚未完整采集，请补充材料、规格与使用场景后验证。'],
        targetAudience: [
          `${market}正在比较${title}与同类商品的买家（假设，需访谈验证）。`,
          `关注${setting}的消费者（假设）。`,
        ],
        purchaseMotivations: [
          `确认${title}是否匹配自己的实际需求。`,
          '比较页面已采集说明与未解决的规格问题，再决定是否购买。',
        ],
        painPoints: [
          '页面信息分散，需要快速了解关键细节（待用户访谈验证）。',
          '可能担心商品与实际使用条件不匹配；先核实条件，不编造缺点（假设）。',
        ],
        strengths: [
          `已保留商品来源和 ASIN，便于继续核查页面信息。已采集 ${product.images.length} 张图片 URL，但模型未观看图片。`,
          ...(claims.length ? ['页面卖点可转成具体核查清单，不能视为品质或效果证明。'] : []),
        ],
        weaknesses: [
          '仅依据已采集页面整理，尚未验证实际质量、耐用性、售后或使用效果。',
          ...(!claims.length ? ['页面未获取到 Bullet Points，当前无法确认具体功能卖点。'] : []),
          ...(!product.price ? ['页面未获取到价格，无法判断价格竞争力。'] : []),
          '评分和评论数量仅为页面快照，未读取具体用户评论。',
          `${market}适用性仍需核查，不推断认证、合规或市场接受度。`,
        ],
        marketingAngles: [
          `场景切入：${setting}，展示${title}与一项已采集说明，不编造效果。`,
          `细节观察：${claims[0] ?? '优先核实尚未采集的规格，再制作演示。'}`,
          `${market}购买前核查：列出使用条件、商品说明与资料缺口。营销目标：${goal}。`,
        ],
        hooks: [
          `准备买${title}？先看一个需要确认的细节。`,
          `${title}适合你吗？先从实际使用条件开始。`,
          '商品页面写了很多，先把核查清单列清楚。',
          `面对${setting}，你会先确认哪项信息？`,
          '下单前，把已知事实和待确认的信息分开。',
          options.style === 'humorous'
            ? '商品说明比购物清单还长？先搞懂一个细节。'
            : '先看真实商品，再核查细节，最后决定是否购买。',
        ],
        shortVideoScript: [
          `Hook: [${timing[0]}] 商品近景，旁白：“准备了解${title}？先确认一个关键细节。”`,
          `Problem: [${timing[1]}] 展示${setting}，旁白：“信息太多时，很难判断商品是否适合自己。”`,
          `Solution: [${timing[2]}] 将实物与页面说明同框，旁白：“先检查已经采集的说明。” ${claims[0] ?? '当前具体功能待补充，不展示未经验证的承诺。'}`,
          `Demo: [${timing[3]}] 实拍外观、尺寸或已核实的操作；未实测的功能标记“待验证”。表达方式：${style}。`,
          `CTA: [${timing[4]}] 旁白：“查看完整商品页面，确认规格与自己的需求，再决定是否购买。”营销目标：${goal}。`,
        ].join('\n\n'),
        imagePrompts: [
          `制作${title}在“${setting}”中的竖屏商品分镜概念图，面向${market}的${options.platform}。自然柔光、真实比例、清晰细节。制作时使用真实参考图保持外观一致，本次未向模型上传图片。不得虚构品牌标识、规格、认证、功效或附加配件。`,
        ],
        videoPrompts: [
          `为${title}制作${options.duration}秒 9:16 ${options.platform}分镜：开场${timing[0]}、需求${timing[1]}、页面核查${timing[2]}、真实操作${timing[3]}、查看详情${timing[4]}。${style}。使用实际商品参考素材和已核实功能，不改变商品结构，不伪造评价或效果对比。`,
        ],
      };
    }
    if (options.customInstructions.trim()) {
      const note = {
        'zh-CN': '用户自定义要求（供人工核查；本机模板不会理解或保证遵守其语义）',
        en: 'User requirement for human review; this template cannot interpret or guarantee compliance with its meaning',
        ja: 'ユーザーの追加要件（人による確認用。この定型デモは意味を解釈・保証しません）',
      }[options.language];
      analysis.weaknesses.push(`${note}: ${options.customInstructions}`);
    }
    const validated = analysisSchema.parse(analysis);
    return { analysis: validated, evidence: capturedEvidence(product, options, validated) };
  }
}
