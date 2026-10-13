import {
  aiTemplateSchema,
  templateBackupSchema,
  type AITemplate,
  type TemplateDefinition,
  type TemplateBackup,
} from '@productspy/shared';
import { webRequest } from './session';

const path = (id: string) => `/api/templates/${encodeURIComponent(id)}`;
export async function listTemplates(): Promise<AITemplate[]> {
  return aiTemplateSchema
    .array()
    .parse((await webRequest<{ templates: unknown[] }>('/api/templates')).templates);
}
export async function createTemplate(definition: TemplateDefinition): Promise<AITemplate> {
  return aiTemplateSchema.parse(
    await webRequest('/api/templates', { method: 'POST', body: JSON.stringify(definition) }),
  );
}
export async function updateTemplate(
  template: AITemplate,
  patch: { definition?: TemplateDefinition; favorite?: boolean; restoreVersionId?: string },
): Promise<AITemplate> {
  return aiTemplateSchema.parse(
    await webRequest(path(template.id), {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, expectedUpdatedAt: template.updatedAt }),
    }),
  );
}
export async function deleteTemplate(template: AITemplate): Promise<void> {
  await webRequest(path(template.id), {
    method: 'DELETE',
    body: JSON.stringify({ confirmed: true, expectedUpdatedAt: template.updatedAt }),
  });
}
export async function backupTemplates(): Promise<TemplateBackup> {
  return templateBackupSchema.parse(await webRequest('/api/templates/backup'));
}
export type TemplateImportPreview = {
  revision: string;
  conflicts: { id: string; name: string }[];
  imported: number;
  skipped: number;
  committed: boolean;
};
export async function importTemplates(
  backup: TemplateBackup,
  expectedRevision?: string,
): Promise<TemplateImportPreview> {
  return webRequest('/api/templates/backup', {
    method: 'POST',
    body: JSON.stringify({
      backup,
      commit: expectedRevision !== undefined,
      ...(expectedRevision ? { expectedRevision, policy: 'skip' } : {}),
    }),
  });
}
