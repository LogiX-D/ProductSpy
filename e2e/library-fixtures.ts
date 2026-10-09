import { randomUUID } from 'node:crypto';
import type { Product, ProductAnalysis } from '../packages/shared/src/types';

export const SYNTHETIC_ANALYSIS: ProductAnalysis = {
  summary: '本地合成样本，用于验证数据保留；不是实际商品或真实 AI 输出。',
  sellingPoints: ['合成样本卖点'],
  targetAudience: ['合成测试受众'],
  purchaseMotivations: ['用于流程验证'],
  painPoints: ['人工测试痛点'],
  strengths: ['测试中的页面事实'],
  weaknesses: ['商业效果未评估'],
  marketingAngles: ['桌面演示测试角度'],
  hooks: ['合成开场一', '合成开场二', '合成开场三', '合成开场四', '合成开场五'],
  shortVideoScript:
    'Hook: 合成开场\nProblem: 合成问题\nSolution: 合成方案\nDemo: 桌面演示\nCTA: 核实资料',
  imagePrompts: ['Synthetic product on a plain desk, no fabricated claims'],
  videoPrompts: ['A synthetic tabletop demo, no fake review claims'],
};

/** Public-domain synthetic test data; never a real Amazon acceptance sample. */
export function libraryFixtures(count: number, prefix = 'B13P'): Product[] {
  return Array.from({ length: count }, (_, index) => {
    const sourceId = `${prefix}${String(index + 1).padStart(10 - prefix.length, '0')}`;
    const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
    const category = ['厨房', '家居', '电子', '美妆', '服装'][index % 5];
    const analyzed = index % 10 === 0;
    return {
      id: `amazon:${sourceId}`,
      source: 'amazon',
      sourceId,
      url: `https://www.amazon.com/dp/${sourceId}`,
      title: `合成样本 ${String(index + 1).padStart(3, '0')} · ${category} · 性能测试专用`,
      brand: 'SyntheticFixture',
      price: `$${(10 + index / 10).toFixed(2)}`,
      currency: 'USD',
      rating: 4.2,
      reviewCount: index,
      images: [],
      videos: [],
      bulletPoints: ['本地合成性能样本；不是实际 Amazon 商品验收', '不发起收费 AI 请求'],
      description: 'Synthetic library workflow data. 中文字段用于验证导入、筛选与完整备份。',
      createdAt,
      updatedAt: createdAt,
      ...(analyzed
        ? {
            aiAnalysis: { ...SYNTHETIC_ANALYSIS },
            analysisHistory: [
              {
                id: randomUUID(),
                createdAt,
                kind: 'edited' as const,
                analysis: { ...SYNTHETIC_ANALYSIS },
              },
            ],
          }
        : {}),
    };
  });
}
