import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  analysisOptionsSummary,
  restoreAnalysisPreferences,
} from './analysis-preferences';

describe('analysis preference validation', () => {
  it('uses explicit default market, language and duration without invented model prices', () => {
    const restored = restoreAnalysisPreferences(null);
    expect(restored.options).toEqual(DEFAULT_ANALYSIS_OPTIONS);
    expect(restored.pricing).toEqual({});
    expect(analysisOptionsSummary(restored.options)).toBe(
      '美国 · 中文 · TikTok · 生活化 · 30 秒 · 了解与比较',
    );
  });
  it('restores valid preferences including zero and decimal explicitly entered pricing', () => {
    const preference = {
      version: 1,
      options: {
        ...DEFAULT_ANALYSIS_OPTIONS,
        market: 'JP',
        language: 'ja',
        duration: 15,
        customInstructions: '不作疗效承诺',
      },
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 2.5 },
    };
    expect(restoreAnalysisPreferences(JSON.stringify(preference))).toEqual(preference);
  });
  it('rejects malformed and unsupported versions and bounds hostile custom content', () => {
    for (const raw of ['null', '[]', '{invalid', '{"version":2,"options":{}}', 'a'.repeat(20001)]) {
      expect(restoreAnalysisPreferences(raw).options).toEqual(DEFAULT_ANALYSIS_OPTIONS);
    }
    const raw = JSON.stringify({
      version: 1,
      options: {
        language: 'invalid',
        market: 'UK',
        duration: 90,
        customInstructions: 'x'.repeat(5000),
      },
      pricing: { inputUsdPerMillion: -1, outputUsdPerMillion: '100' },
      apiKey: 'should never be restored',
    });
    const restored = restoreAnalysisPreferences(raw);
    expect(restored.options.market).toBe('UK');
    expect(restored.options.language).toBe('zh-CN');
    expect(restored.options.duration).toBe(30);
    expect(restored.options.customInstructions).toHaveLength(4000);
    expect(restored.pricing).toEqual({});
    expect(JSON.stringify(restored)).not.toContain('apiKey');
  });
  it('never allows persisted state to inject unsupported generation or authorization flags', () => {
    const restored = restoreAnalysisPreferences(
      JSON.stringify({
        version: 1,
        options: { ...DEFAULT_ANALYSIS_OPTIONS, authorizeReal: true },
        pricing: { inputUsdPerMillion: 1000001 },
        fields: [],
        authorizeReal: true,
      }),
    );
    expect(Object.keys(restored.options)).toEqual(Object.keys(DEFAULT_ANALYSIS_OPTIONS));
    expect(restored.pricing).toEqual({});
  });
});
