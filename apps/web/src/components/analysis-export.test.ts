import { describe, expect, it } from 'vitest';
import type { ProductAnalysis } from '@productspy/shared';
import { analysisProvenance } from './analysis-history';
import { DEFAULT_ANALYSIS_OPTIONS } from './analysis-preferences';
import { analysisDifferences, analysisExportFilename, exportAnalysisText } from './analysis-export';

const analysis: ProductAnalysis = {
  summary: 'Mock 演示分析：便携水杯\n仅根据页面资料。',
  sellingPoints: ['密封杯盖'],
  targetAudience: ['通勤用户'],
  purchaseMotivations: ['随身饮水'],
  painPoints: ['携带不方便'],
  strengths: ['资料中列有杯盖'],
  weaknesses: ['保温效果待验证'],
  marketingAngles: ['出门准备'],
  hooks: ['一', '二', '三', '四', '五'],
  shortVideoScript:
    'Hook: 带水出门\nProblem: 拿取不便\nSolution: 使用水杯\nDemo: 装水\nCTA: 查看详情',
  imagePrompts: ['桌面上的水杯'],
  videoPrompts: ['打开杯盖\n展示杯身'],
};
const product = {
  title: 'Travel Bottle',
  sourceId: 'B000000001',
  url: 'https://www.amazon.com/dp/B000000001',
};

describe('analysis exports and comparison', () => {
  it('exports every result, multiline content, product source and inference boundary as TXT', () => {
    const result = exportAnalysisText(product, analysis, 'txt', '本机演示 · 未调用外部模型');
    expect(result).toContain(product.url);
    expect(result).toContain('未采集或分析真实评论正文');
    expect(result).toContain('Mock 演示分析');
    expect(result).toContain('打开杯盖\n展示杯身');
    for (const field of Object.values(analysis)) {
      if (Array.isArray(field)) for (const item of field) expect(result).toContain(item);
    }
  });
  it('exports readable Markdown without dropping script or repeated list values', () => {
    const result = exportAnalysisText(product, analysis, 'md');
    expect(result).toContain('# Travel Bottle');
    expect(result).toContain('## 开场文案');
    expect(result).toContain('## 短视频脚本');
    expect(result).toContain('开场吸引：带水出门');
    expect(result).toContain('• 五');
    expect(result.endsWith('\n')).toBe(true);
  });
  it('compares semantic field values and retains array ordering and line changes', () => {
    const copy = structuredClone(analysis);
    expect(analysisDifferences(analysis, copy)).toEqual([]);
    copy.hooks.reverse();
    copy.summary += '\n人工修改';
    expect(analysisDifferences(analysis, copy)).toEqual(['summary', 'hooks']);
    expect(analysis.hooks[0]).toBe('一');
  });
  it('uses a bounded filesystem-safe export filename', () => {
    expect(analysisExportFilename('../B000000001\\:x', 'md')).toBe(
      'ProductSpy-B000000001x-analysis.md',
    );
    expect(analysisExportFilename('中文', 'txt')).toBe('ProductSpy-product-analysis.txt');
  });

  it('discloses partial generation scope without attributing the retained content to the new language or model', () => {
    const provenance = analysisProvenance({
      mode: 'real',
      model: 'stub-model',
      options: { ...DEFAULT_ANALYSIS_OPTIONS, language: 'ja', customInstructions: '不提保温性能' },
      generatedAt: '2026-10-09T01:02:00.000Z',
      sourceUpdatedAt: '2026-10-09T01:00:00.000Z',
      selectedFields: ['hooks'],
      evidence: { facts: [], inferences: [], unknowns: [], reviewTextAnalyzed: false },
    });
    expect(provenance).toContain('本次参数仅应用：开场文案');
    expect(provenance).toContain('其余内容保留原版本');
    expect(provenance).toContain('不提保温性能');
    expect(exportAnalysisText(product, analysis, 'md', provenance)).toContain('证据区来自本次生成');
  });
});
