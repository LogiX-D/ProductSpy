import { describe, expect, it } from 'vitest';
import { analysisSchema, type ProductAnalysis } from '@productspy/shared';
import { analysisCopy } from './analysis-copy';
import {
  analysisAllText,
  analysisListFields,
  analysisSectionText,
  analysisSections,
  createAnalysisDraft,
  draftToAnalysis,
  isMockAnalysis,
  parseScript,
  restoreSessionDraft,
  validateAnalysisDraft,
  type AnalysisSessionDraft,
} from './analysis-utils';

const analysis: ProductAnalysis = {
  summary: '商品总结第一行\n第二行',
  sellingPoints: ['卖点第一行\n第二行'],
  targetAudience: ['目标用户'],
  purchaseMotivations: ['购买动机'],
  painPoints: ['用户痛点'],
  strengths: ['商品优势'],
  weaknesses: ['不足与待验证'],
  marketingAngles: ['营销角度'],
  hooks: ['开场1', '开场2', '开场3', '开场4', '开场5'],
  shortVideoScript:
    'Hook: 开场第一行\n第二行\n\nProblem: 问题\nSolution: 方案\nDemo: 演示\nCTA: 引导',
  imagePrompts: ['图片提示第一行\n图片提示第二行'],
  videoPrompts: ['视频提示第一行\n视频提示第二行'],
};

describe('analysis text and editor helpers', () => {
  it('displays original English script labels in Chinese without dropping multiline content', () => {
    const steps = parseScript(analysis.shortVideoScript);
    expect(steps.map((step) => step.label)).toEqual(Object.values(analysisCopy.scriptSteps));
    expect(steps[0]).toMatchObject({ key: 'Hook', content: '开场第一行\n第二行' });
    const legacy = parseScript(
      'hook：开场\r\nProblem: 问题\r\nSolution: 方案\r\nDemo: 演示\r\nCTA: 引导',
    );
    expect(legacy).toHaveLength(5);
    expect(legacy[0].label).toBe('开场吸引');
  });

  it('reads Chinese script labels and preserves text that has no recognized headings', () => {
    expect(parseScript('开场吸引：一句话\n提出问题：问题')[0]).toMatchObject({
      key: 'Hook',
      content: '一句话',
    });
    expect(parseScript('未经分段\n这段不能丢')).toEqual([
      { key: 'raw', label: '短视频脚本', content: '未经分段\n这段不能丢' },
    ]);
    expect(parseScript('前言\nHook: 开场')[0].content).toBe('前言');
  });

  it('keeps every analysis field and multiline item while encoding the original script schema', () => {
    const draft = createAnalysisDraft(analysis);
    draft.sellingPoints[0] += '\n第三行';
    draft.shortVideoScript.Demo = '演示第一行\n演示第二行\n';
    const result = draftToAnalysis(draft);
    expect(result.sellingPoints[0]).toBe('卖点第一行\n第二行\n第三行');
    expect(result.shortVideoScript).toContain('Demo: 演示第一行\n演示第二行\n');
    expect(analysisSchema.safeParse(result).success).toBe(true);
    expect(Object.keys(result)).toHaveLength(12);
    expect(analysis.sellingPoints[0]).toBe('卖点第一行\n第二行');
  });

  it('copies all nine Chinese sections and every stored field', () => {
    const text = analysisAllText(analysis);
    for (const section of analysisSections) expect(text).toContain(section.label);
    expect(text).toContain(analysis.summary);
    for (const field of analysisListFields)
      for (const item of analysis[field]) expect(text).toContain(item);
    expect(text).toContain('开场吸引：开场第一行\n第二行');
    expect(text).toContain('行动引导：引导');
    expect(analysisSectionText(analysis, 'audience')).toContain('购买动机\n• 购买动机');
    expect(analysisSectionText(analysis, 'strengths')).toContain('不足与待验证');
    expect(analysisSectionText(analysis, 'imagePrompts')).toBe(
      '图片提示词\n• 图片提示第一行\n图片提示第二行',
    );
  });

  it('preserves the mock disclosure even when the summary is replaced by hand', () => {
    const draft = createAnalysisDraft(analysis);
    draft.summary = '手工修改的总结';
    const result = draftToAnalysis(draft, true);
    expect(result.summary).toBe('Mock 演示分析（手工编辑）：手工修改的总结');
    expect(analysisAllText(result)).toContain(analysisCopy.mockNotice);
    expect(draftToAnalysis(createAnalysisDraft(result), true).summary).toBe(result.summary);
    draft.summary = '';
    expect(validateAnalysisDraft(draft, true)).toContain(analysisCopy.validationSummary);
  });

  it('recognizes localized Mock results and preserves the requested disclosure language after editing', () => {
    for (const summary of [
      'Mock demo analysis: Travel Bottle',
      'Mock デモ分析：水筒',
      'Mock 演示分析：水杯',
    ]) {
      expect(isMockAnalysis(summary)).toBe(true);
      expect(draftToAnalysis(createAnalysisDraft({ ...analysis, summary }), true).summary).toBe(
        summary,
      );
    }
    expect(isMockAnalysis('The product supports a Mock interface')).toBe(false);
    const draft = createAnalysisDraft(analysis);
    draft.summary = 'Edited summary';
    expect(draftToAnalysis(draft, true, 'Mock demo analysis (manually edited): ').summary).toBe(
      'Mock demo analysis (manually edited): Edited summary',
    );
  });

  it('rejects invalid hooks, missing script segments, and oversized scripts before saving', () => {
    const draft = createAnalysisDraft(analysis);
    draft.hooks = ['仅一条'];
    draft.shortVideoScript.CTA = '';
    const errors = validateAnalysisDraft(draft);
    expect(errors).toContain(analysisCopy.validationHooks);
    expect(errors).toContain(analysisCopy.validationScript);
    draft.hooks = analysis.hooks;
    draft.shortVideoScript.CTA = 'a'.repeat(12000);
    expect(validateAnalysisDraft(draft)).toContain(analysisCopy.validationScript);
    expect(validateAnalysisDraft(createAnalysisDraft(analysis))).toEqual([]);
    expect(analysisSchema.safeParse({ ...analysis, shortVideoScript: 'Hook: 开场' }).success).toBe(
      false,
    );
  });
});

describe('same-tab analysis drafts', () => {
  const baseline = '2026-10-09T01:00:00.000Z';
  const session: AnalysisSessionDraft = {
    version: 1,
    productId: 'product-a',
    baselineUpdatedAt: baseline,
    savedAt: baseline,
    isMock: true,
    draft: createAnalysisDraft(analysis),
  };

  it('restores drafts with the baseline version intact, including temporarily invalid edits', () => {
    const invalid = { ...session, draft: { ...session.draft, hooks: ['还没写完'] } };
    expect(restoreSessionDraft(JSON.stringify(invalid), 'product-a', baseline)).toEqual({
      session: invalid,
      stale: false,
    });
    const stale = restoreSessionDraft(
      JSON.stringify(session),
      'product-a',
      '2026-10-09T02:00:00.000Z',
    );
    expect(stale?.stale).toBe(true);
    expect(stale?.session.baselineUpdatedAt).toBe(baseline);
  });

  it('rejects obsolete versions, other products, malformed fields, and excessive content', () => {
    expect(
      restoreSessionDraft(JSON.stringify({ ...session, version: 0 }), 'product-a', baseline),
    ).toBeUndefined();
    expect(restoreSessionDraft(JSON.stringify(session), 'product-b', baseline)).toBeUndefined();
    expect(restoreSessionDraft('{', 'product-a', baseline)).toBeUndefined();
    expect(
      restoreSessionDraft(
        JSON.stringify({ ...session, baselineUpdatedAt: 'yesterday' }),
        'product-a',
        baseline,
      ),
    ).toBeUndefined();
    expect(
      restoreSessionDraft(
        JSON.stringify({
          ...session,
          draft: { ...session.draft, apiKey: 'not-an-analysis-field' },
        }),
        'product-a',
        baseline,
      ),
    ).toBeUndefined();
    expect(
      restoreSessionDraft(
        JSON.stringify({
          ...session,
          draft: { ...session.draft, hooks: Array.from({ length: 31 }, () => '开场') },
        }),
        'product-a',
        baseline,
      ),
    ).toBeUndefined();
    expect(
      restoreSessionDraft(
        JSON.stringify({ ...session, draft: { ...session.draft, summary: 'a'.repeat(12001) } }),
        'product-a',
        baseline,
      ),
    ).toBeUndefined();
    expect(
      restoreSessionDraft(
        JSON.stringify({
          ...session,
          draft: { ...session.draft, shortVideoScript: 'Hook: 不再使用旧草稿结构' },
        }),
        'product-a',
        baseline,
      ),
    ).toBeUndefined();
  });
});
