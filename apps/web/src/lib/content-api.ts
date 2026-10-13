import {
  contentPlanSchema,
  contentBackupSchema,
  type ContentPlan,
  type ContentOptions,
  type ContentOutput,
  type ContentField,
  type ContentGenerationResponse,
  type AnalysisPricing,
} from '@productspy/shared';
import { webRequest } from './session';

const path = (id: string) => `/api/content-plans/${encodeURIComponent(id)}`;
export async function listContentPlans(): Promise<ContentPlan[]> {
  return contentPlanSchema
    .array()
    .parse((await webRequest<{ plans: unknown[] }>('/api/content-plans')).plans);
}
export async function getContentPlan(id: string): Promise<ContentPlan> {
  return contentPlanSchema.parse(await webRequest(path(id)));
}
export async function createContentPlan(input: {
  name: string;
  productId: string;
  templateId: string;
  options: ContentOptions;
  comparisonId?: string;
}): Promise<ContentPlan> {
  return contentPlanSchema.parse(
    await webRequest('/api/content-plans', { method: 'POST', body: JSON.stringify(input) }),
  );
}
export async function updateContentPlan(
  plan: ContentPlan,
  patch: {
    name?: string;
    status?: ContentPlan['status'];
    favorite?: boolean;
    output?: ContentOutput;
    restoreVersionId?: string;
    adoptVersionId?: string;
  },
): Promise<ContentPlan> {
  return contentPlanSchema.parse(
    await webRequest(path(plan.id), {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, expectedUpdatedAt: plan.updatedAt }),
    }),
  );
}
export async function deleteContentPlan(plan: ContentPlan): Promise<void> {
  await webRequest(path(plan.id), {
    method: 'DELETE',
    body: JSON.stringify({ confirmed: true, expectedUpdatedAt: plan.updatedAt }),
  });
}
export type ContentGenerationRequest = {
  planId: string;
  expectedUpdatedAt: string;
  options: ContentOptions;
  selectedFields?: ContentField[];
  requestId: string;
  authorizeReal?: boolean;
  pricing?: AnalysisPricing;
};
export async function generateContent(
  input: ContentGenerationRequest,
): Promise<ContentGenerationResponse> {
  const value = await webRequest<ContentGenerationResponse>('/api/generate-content', {
    method: 'POST',
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(135000),
  });
  return { ...value, plan: contentPlanSchema.parse(value.plan) };
}
export async function backupContentPlans() {
  return contentBackupSchema.parse(await webRequest('/api/content-plans/backup'));
}
export type ContentBackup = ReturnType<typeof contentBackupSchema.parse>;
export type ContentImportPreview = {
  total: number;
  revision: string;
  conflicts: { id: string; name: string }[];
  imported: number;
  skipped: number;
};
export async function importContentPlans(
  backup: ContentBackup,
  expectedRevision?: string,
): Promise<ContentImportPreview> {
  return webRequest('/api/content-plans/backup', {
    method: 'POST',
    body: JSON.stringify({
      backup,
      commit: expectedRevision !== undefined,
      ...(expectedRevision ? { expectedRevision, policy: 'skip' } : {}),
    }),
  });
}
