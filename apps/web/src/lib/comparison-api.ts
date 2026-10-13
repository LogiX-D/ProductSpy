import {
  comparisonBackupSchema,
  comparisonPlanSchema,
  type AnalysisOptions,
  type AnalysisPricing,
  type ComparisonAnalysis,
  type ComparisonPlan,
} from '@productspy/shared';
import { webRequest } from './session';

const planPath = (id: string) => `/api/comparisons/${encodeURIComponent(id)}`;

export async function listComparisons(): Promise<ComparisonPlan[]> {
  const result = await webRequest<{ plans: unknown[] }>('/api/comparisons');
  return comparisonPlanSchema.array().parse(result.plans);
}
export async function getComparison(id: string): Promise<ComparisonPlan> {
  return comparisonPlanSchema.parse(await webRequest<unknown>(planPath(id)));
}
export async function createComparison(
  name: string,
  productIds: string[],
): Promise<ComparisonPlan> {
  return comparisonPlanSchema.parse(
    await webRequest<unknown>('/api/comparisons', {
      method: 'POST',
      body: JSON.stringify({ name, productIds }),
    }),
  );
}
export async function updateComparison(
  plan: ComparisonPlan,
  patch: {
    name?: string;
    productIds?: string[];
    refreshSnapshots?: boolean;
    analysis?: ComparisonAnalysis;
    restoreVersionId?: string;
  },
): Promise<ComparisonPlan> {
  return comparisonPlanSchema.parse(
    await webRequest<unknown>(planPath(plan.id), {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, expectedUpdatedAt: plan.updatedAt }),
    }),
  );
}
export async function deleteComparison(plan: ComparisonPlan): Promise<void> {
  await webRequest<unknown>(planPath(plan.id), {
    method: 'DELETE',
    body: JSON.stringify({ expectedUpdatedAt: plan.updatedAt, confirmed: true }),
  });
}
export type ComparisonGenerationRequest = {
  comparisonId: string;
  expectedUpdatedAt: string;
  options: AnalysisOptions;
  pricing?: AnalysisPricing;
  requestId: string;
  authorizeReal?: boolean;
};
export async function analyzeComparison(
  request: ComparisonGenerationRequest,
): Promise<ComparisonPlan> {
  const result = await webRequest<{ plan: unknown }>('/api/analyze-comparison', {
    method: 'POST',
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(135_000),
  });
  return comparisonPlanSchema.parse(result.plan);
}

export function comparisonSelectionHref(ids: string[]): string {
  return `/comparisons?products=${encodeURIComponent(ids.slice(0, 5).join(','))}`;
}

export type ComparisonBackup = ReturnType<typeof comparisonBackupSchema.parse>;
export type ComparisonImportResult = {
  total: number;
  imported: number;
  skipped: number;
  conflicts: { id: string; name: string }[];
  revision: string;
};
export async function backupComparisons(): Promise<ComparisonBackup> {
  return comparisonBackupSchema.parse(await webRequest<unknown>('/api/comparisons/backup'));
}
export async function importComparisons(
  backup: ComparisonBackup,
  expectedRevision?: string,
): Promise<ComparisonImportResult> {
  return webRequest<ComparisonImportResult>('/api/comparisons/backup', {
    method: 'POST',
    body: JSON.stringify({
      backup,
      commit: expectedRevision !== undefined,
      ...(expectedRevision !== undefined ? { expectedRevision, policy: 'skip' } : {}),
    }),
  });
}
