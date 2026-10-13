import {
  DEFAULT_CONTENT_OPTIONS,
  contentOptionsSchema,
  type ContentOptions,
} from '@productspy/shared';
import { restoreAnalysisPreferences, type AnalysisPricingPreference } from './analysis-preferences';

export const CONTENT_PREFERENCES_KEY = 'productspy:content-preferences:v1';

export function restoreContentPreferences(
  raw: string | null,
  analysisRaw?: string | null,
): {
  options: ContentOptions;
  pricing: AnalysisPricingPreference;
} {
  const result = {
    options: { ...DEFAULT_CONTENT_OPTIONS },
    pricing: {} as AnalysisPricingPreference,
  };
  if (!raw && analysisRaw) {
    const previous = restoreAnalysisPreferences(analysisRaw);
    result.options = contentOptionsSchema.parse(previous.options);
    result.pricing = previous.pricing;
    return result;
  }
  if (!raw || raw.length > 20000) return result;
  try {
    const saved: unknown = JSON.parse(raw);
    if (
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      !('version' in saved) ||
      saved.version !== 1
    )
      return result;
    if ('options' in saved) {
      const parsed = contentOptionsSchema.safeParse(saved.options);
      if (parsed.success) result.options = parsed.data;
    }
    if (
      'pricing' in saved &&
      saved.pricing &&
      typeof saved.pricing === 'object' &&
      !Array.isArray(saved.pricing)
    ) {
      const values = saved.pricing as Record<string, unknown>;
      for (const field of ['inputUsdPerMillion', 'outputUsdPerMillion'] as const) {
        const value = values[field];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000)
          result.pricing[field] = value;
      }
    }
    return result;
  } catch {
    return result;
  }
}
