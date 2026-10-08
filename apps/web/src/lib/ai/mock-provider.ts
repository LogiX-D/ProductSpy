import {
  analysisSchema,
  type AIProvider,
  type Product,
  type ProductAnalysis,
} from '@productspy/shared';

export class MockAIProvider implements AIProvider {
  async analyze(product: Product): Promise<ProductAnalysis> {
    const title = product.title.slice(0, 240);
    const claims = product.bulletPoints
      .filter((point) => point.trim())
      .slice(0, 6)
      .map((point) => `页面宣称：${point.slice(0, 600)}`);
    const sellingPoints = claims.length
      ? claims
      : ['商品卖点尚未完整采集，请补充材料、规格与使用场景后验证。'];
    const weaknesses = [
      '仅依据已采集页面整理，尚未验证实际质量、耐用性、售后或使用效果。',
      ...(product.bulletPoints.length
        ? []
        : ['页面未获取到 Bullet Points，当前无法确认具体功能卖点。']),
      ...(product.price ? [] : ['页面未获取到价格，无法判断价格竞争力。']),
      ...(product.rating === undefined || product.reviewCount === undefined
        ? ['评分或评论数量缺失，无法据此判断用户口碑。']
        : ['评分和评论数量仅为页面快照，未读取具体用户评论。']),
    ];
    return analysisSchema.parse({
      summary: `Mock 演示分析：${title}。以下受众、痛点和营销方向为待验证的创意假设；未调用真实 AI，也未验证商品功效。`,
      sellingPoints,
      targetAudience: [
        '正在比较同类商品的潜在买家（假设）',
        '关注实际使用场景与细节的消费者（假设）',
        '希望获得清晰购买信息的首次购买者（假设）',
      ],
      purchaseMotivations: [
        '确认商品是否匹配自己的实际需求。',
        '比较页面卖点与现有方案的差异。',
        '通过实拍演示降低购买前的不确定感。',
      ],
      painPoints: [
        '页面信息分散，需要快速了解关键细节（待用户访谈验证）。',
        '担心展示效果与实际体验存在差异（待验证）。',
        '难以判断此商品是否适合自己的使用场景（待验证）。',
      ],
      strengths: [
        product.images.length
          ? `已采集 ${product.images.length} 张图片，可作为详情核查与分镜参考。`
          : '已保留商品来源和 ASIN，便于继续核查页面信息。',
        product.bulletPoints.length
          ? '页面包含可用于整理内容结构的卖点说明，效果仍需实测。'
          : '已保留商品标题与链接，可继续补充商品规格和卖点。',
      ],
      weaknesses,
      marketingAngles: [
        '场景切入：展示一个真实需求，再说明商品能否匹配；先核实功能再制作演示。',
        '细节观察：逐项展示外观与页面已经提供的规格，避免添加未采集的参数。',
        '购买前核查：回答适用场景、规格与价格等问题，缺失信息明确标记为待确认。',
      ],
      hooks: [
        `准备买${title}？先看这几个需要确认的细节。`,
        '同类商品怎么选？先从你的使用场景开始。',
        '商品页面写了很多，哪些信息真的与你有关？',
        '下单前，先把规格、功能和适用场景核实清楚。',
        '用一个具体场景，看懂这款商品值得关注的地方。',
        '别急着判断效果，先看真实演示与已经确认的信息。',
      ],
      shortVideoScript: [
        `Hook: 画面展示商品与标题，旁白：“准备了解${title}？先看几个关键细节。”`,
        'Problem: 展示一个待验证的使用需求，旁白：“信息太多时，很难判断商品是否适合自己。”',
        `Solution: 放大页面已采集信息，旁白：“先检查商品页面提供的说明。”${claims[0] ? ` 屏幕参考：${claims[0]}` : ' 当前具体功能待补充，不展示未经验证的承诺。'}`,
        'Demo: 使用真实素材拍摄外观、规格和实际操作。未实测的功能以“待验证”标记，不编造前后对比或效果。',
        'CTA: 旁白：“查看完整商品页面，确认规格与自己的需求，再决定是否购买。”',
      ].join('\n\n'),
      imagePrompts: [
        `制作 ${title} 的商品展示图。使用实际商品参考图保持外观一致，干净中性背景、自然柔光、清晰细节。不要虚构品牌标识、规格、认证、功效或附加配件。`,
        '制作商品使用场景分镜概念图。具体场景与尺寸须由真实商品资料确认；画面保持客观，不添加疗效、保证结果或未经验证的宣传文字。',
      ],
      videoPrompts: [
        `为 ${title} 制作 15 秒竖屏商品介绍分镜：开场展示外观、需求场景、已核实细节、真实操作、查看详情 CTA。使用实际商品参考素材，不改变商品结构，不生成未经证实的效果对比。`,
        '制作 9:16 商品细节视频概念：自然光下缓慢展示外观，再切至已经核实的实际使用镜头。所有功能、配件与使用结果需与实拍资料一致；缺失信息保持留白。',
      ],
    });
  }
}
