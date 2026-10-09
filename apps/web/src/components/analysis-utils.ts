import { analysisSchema, type ProductAnalysis } from '@productspy/shared';
import { analysisCopy } from './analysis-copy';

export const scriptKeys = ['Hook', 'Problem', 'Solution', 'Demo', 'CTA'] as const;
export type ScriptKey = (typeof scriptKeys)[number];
export type ScriptDraft = Record<ScriptKey, string>;
export type AnalysisDraft = Omit<ProductAnalysis, 'shortVideoScript'> & {
  shortVideoScript: ScriptDraft;
};
export const analysisListFields = [
  'sellingPoints',
  'targetAudience',
  'purchaseMotivations',
  'painPoints',
  'strengths',
  'weaknesses',
  'marketingAngles',
  'hooks',
  'imagePrompts',
  'videoPrompts',
] as const;
export type AnalysisListField = (typeof analysisListFields)[number];
export const analysisSections = [
  { id: 'summary', label: analysisCopy.summary },
  { id: 'sellingPoints', label: analysisCopy.sellingPoints },
  { id: 'audience', label: analysisCopy.audience },
  { id: 'strengths', label: analysisCopy.strengthsSection },
  { id: 'marketingAngles', label: analysisCopy.marketingAngles },
  { id: 'hooks', label: analysisCopy.hooks },
  { id: 'shortVideoScript', label: analysisCopy.shortVideoScript },
  { id: 'imagePrompts', label: analysisCopy.imagePrompts },
  { id: 'videoPrompts', label: analysisCopy.videoPrompts },
] as const;
export type AnalysisSectionId = (typeof analysisSections)[number]['id'];
export type ScriptStep = { key: ScriptKey | 'raw'; label: string; content: string };

export function parseScript(script: string): ScriptStep[] {
  const chineseLabels = Object.values(analysisCopy.scriptSteps);
  const labels = [...scriptKeys, ...chineseLabels].join('|');
  const matches = [
    ...script.matchAll(new RegExp(`(?:^|\\r?\\n)(${labels})[ \\t]*[:：][ \\t]*`, 'gi')),
  ];
  if (!matches.length)
    return [{ key: 'raw', label: analysisCopy.shortVideoScript, content: script }];
  const result: ScriptStep[] = [];
  const prelude = script.slice(0, matches[0].index).trim();
  if (prelude) result.push({ key: 'raw', label: analysisCopy.shortVideoScript, content: prelude });
  for (const [index, match] of matches.entries()) {
    const key = scriptKeys.find(
      (candidate) =>
        candidate.toLowerCase() === match[1].toLowerCase() ||
        analysisCopy.scriptSteps[candidate] === match[1],
    )!;
    result.push({
      key,
      label: analysisCopy.scriptSteps[key],
      content: script
        .slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? script.length)
        .trim(),
    });
  }
  return result;
}

export function createAnalysisDraft(analysis: ProductAnalysis): AnalysisDraft {
  const parts: ScriptDraft = { Hook: '', Problem: '', Solution: '', Demo: '', CTA: '' };
  for (const step of parseScript(analysis.shortVideoScript)) {
    if (step.key === 'raw') parts.Hook += `${parts.Hook ? '\n\n' : ''}${step.content}`;
    else parts[step.key] += `${parts[step.key] ? '\n\n' : ''}${step.content}`;
  }
  return {
    ...analysis,
    ...Object.fromEntries(analysisListFields.map((field) => [field, [...analysis[field]]])),
    shortVideoScript: parts,
  };
}

export function draftToAnalysis(draft: AnalysisDraft, isMock = false): ProductAnalysis {
  const summary =
    isMock && !isMockAnalysis(draft.summary)
      ? `${analysisCopy.mockSummaryPrefix}${draft.summary}`
      : draft.summary;
  return {
    ...draft,
    summary,
    shortVideoScript: scriptKeys
      .map((key) => `${key}: ${draft.shortVideoScript[key]}`)
      .join('\n\n'),
  };
}

export function isMockAnalysis(summary: string): boolean {
  return /Mock\s*演示分析/i.test(summary);
}

export function validateAnalysisDraft(draft: AnalysisDraft, isMock = false): string[] {
  const result = analysisSchema.safeParse(draftToAnalysis(draft, isMock));
  const errors = new Set<string>();
  if (!draft.summary.trim()) errors.add(analysisCopy.validationSummary);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0] as keyof ProductAnalysis;
      if (field === 'summary') errors.add(analysisCopy.validationSummary);
      else if (field === 'shortVideoScript') errors.add(analysisCopy.validationScript);
      else if (field === 'hooks') errors.add(analysisCopy.validationHooks);
      else if (analysisListFields.includes(field as AnalysisListField)) {
        errors.add(`${analysisCopy[field as AnalysisListField]}：${analysisCopy.validationList}`);
      }
    }
  }
  if (scriptKeys.some((key) => !draft.shortVideoScript[key].trim())) {
    errors.add(analysisCopy.validationScript);
  }
  return [...errors];
}

const listText = (items: string[]) => items.map((item) => `• ${item}`).join('\n');
const fieldText = (label: string, items: string[]) => `${label}\n${listText(items)}`;

export function analysisSectionText(analysis: ProductAnalysis, section: AnalysisSectionId): string {
  const title = analysisSections.find(({ id }) => id === section)!.label;
  let content: string;
  if (section === 'summary') content = analysis.summary;
  else if (section === 'audience') {
    content = [
      fieldText(analysisCopy.targetAudience, analysis.targetAudience),
      fieldText(analysisCopy.purchaseMotivations, analysis.purchaseMotivations),
      fieldText(analysisCopy.painPoints, analysis.painPoints),
    ].join('\n\n');
  } else if (section === 'strengths') {
    content = [
      fieldText(analysisCopy.strengths, analysis.strengths),
      fieldText(analysisCopy.weaknesses, analysis.weaknesses),
    ].join('\n\n');
  } else if (section === 'shortVideoScript') {
    content = parseScript(analysis.shortVideoScript)
      .map((step) => `${step.label}：${step.content}`)
      .join('\n\n');
  } else content = listText(analysis[section]);
  return `${title}\n${content}`;
}

export function analysisAllText(
  analysis: ProductAnalysis,
  isMock = isMockAnalysis(analysis.summary),
): string {
  return [
    ...(isMock ? [analysisCopy.mockNotice] : []),
    ...analysisSections.map(({ id }) => analysisSectionText(analysis, id)),
  ].join('\n\n');
}

export type AnalysisSessionDraft = {
  version: 1;
  productId: string;
  baselineUpdatedAt: string;
  savedAt: string;
  isMock: boolean;
  draft: AnalysisDraft;
};
export const sessionDraftKey = (productId: string) => `productspy:analysis-draft:v1:${productId}`;
export const sessionDraftMaxCharacters = 4_000_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const boundedText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 12000;
const isDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));

export function restoreSessionDraft(
  serialized: string | null,
  productId: string,
  currentUpdatedAt: string,
): { session: AnalysisSessionDraft; stale: boolean } | undefined {
  if (!serialized || serialized.length > sessionDraftMaxCharacters) return undefined;
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.productId !== productId ||
      !isDate(value.baselineUpdatedAt) ||
      !isDate(value.savedAt) ||
      typeof value.isMock !== 'boolean'
    )
      return undefined;
    if (
      Object.keys(value).some(
        (key) =>
          !['version', 'productId', 'baselineUpdatedAt', 'savedAt', 'isMock', 'draft'].includes(
            key,
          ),
      )
    )
      return undefined;
    const draft = value.draft;
    if (!isRecord(draft) || !boundedText(draft.summary) || Object.keys(draft).length !== 12)
      return undefined;
    if (
      !analysisListFields.every(
        (field) =>
          Array.isArray(draft[field]) &&
          draft[field].length <= 30 &&
          draft[field].every(boundedText),
      )
    )
      return undefined;
    if (
      !isRecord(draft.shortVideoScript) ||
      Object.keys(draft.shortVideoScript).length !== 5 ||
      !scriptKeys.every((key) =>
        boundedText((draft.shortVideoScript as Record<string, unknown>)[key]),
      )
    )
      return undefined;
    return {
      session: value as AnalysisSessionDraft,
      stale: value.baselineUpdatedAt !== currentUpdatedAt,
    };
  } catch {
    return undefined;
  }
}
