import {
  DEFAULT_ANALYSIS_OPTIONS,
  type AnalysisOptions,
  type AnalysisPricing,
} from '@productspy/shared';

export { DEFAULT_ANALYSIS_OPTIONS } from '@productspy/shared';

export const ANALYSIS_PREFERENCES_KEY = 'productspy:analysis-preferences:v1';
export const analysisOptionChoices = {
  market: [
    { value: 'US', label: '美国' },
    { value: 'UK', label: '英国' },
    { value: 'EU', label: '欧洲' },
    { value: 'JP', label: '日本' },
  ],
  language: [
    { value: 'zh-CN', label: '中文' },
    { value: 'en', label: '英文' },
    { value: 'ja', label: '日文' },
  ],
  platform: [
    { value: 'TikTok', label: 'TikTok' },
    { value: 'Reels', label: 'Reels' },
    { value: 'Shorts', label: 'Shorts' },
  ],
  style: [
    { value: 'professional', label: '专业' },
    { value: 'casual', label: '生活化' },
    { value: 'humorous', label: '幽默' },
    { value: 'recommendation', label: '种草' },
  ],
  duration: [
    { value: 15, label: '15 秒' },
    { value: 30, label: '30 秒' },
    { value: 60, label: '60 秒' },
  ],
  goal: [
    { value: 'awareness', label: '认识商品' },
    { value: 'consideration', label: '了解与比较' },
    { value: 'conversion', label: '促进购买' },
  ],
} as const;
export type AnalysisPricingPreference = Partial<AnalysisPricing>;
export type AnalysisPreferences = {
  version: 1;
  options: AnalysisOptions;
  pricing: AnalysisPricingPreference;
};

export function restoreAnalysisPreferences(raw: string | null): AnalysisPreferences {
  const fallback: AnalysisPreferences = {
    version: 1,
    options: { ...DEFAULT_ANALYSIS_OPTIONS },
    pricing: {},
  };
  if (!raw || raw.length > 20000) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const value = parsed as Record<string, unknown>;
    if (
      value.version !== 1 ||
      !value.options ||
      typeof value.options !== 'object' ||
      Array.isArray(value.options)
    )
      return fallback;
    const options = value.options as Record<string, unknown>;
    for (const key of Object.keys(
      analysisOptionChoices,
    ) as (keyof typeof analysisOptionChoices)[]) {
      const choice = analysisOptionChoices[key].find(({ value }) => value === options[key]);
      if (choice) Object.assign(fallback.options, { [key]: choice.value });
    }
    if (typeof options.customInstructions === 'string')
      fallback.options.customInstructions = options.customInstructions.slice(0, 4000);
    if (value.pricing && typeof value.pricing === 'object' && !Array.isArray(value.pricing)) {
      const pricing = value.pricing as Record<string, unknown>;
      for (const field of ['inputUsdPerMillion', 'outputUsdPerMillion'] as const) {
        const price = pricing[field];
        if (typeof price === 'number' && Number.isFinite(price) && price >= 0 && price <= 10000)
          fallback.pricing[field] = price;
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function analysisOptionsSummary(options: AnalysisOptions): string {
  return (Object.keys(analysisOptionChoices) as (keyof typeof analysisOptionChoices)[])
    .map(
      (key) =>
        analysisOptionChoices[key].find(({ value }) => value === options[key])?.label ??
        String(options[key]),
    )
    .join(' · ');
}
