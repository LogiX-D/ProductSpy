import {
  templateBackupSchema,
  templateDefinition,
  type AITemplate,
  type TemplateBackup,
} from '@productspy/shared';

/** Built-ins are copied under fresh identifiers so importing never replaces program templates. */
export function singleTemplateBackup(
  template: AITemplate,
  now = new Date().toISOString(),
  uuid: () => string = () => crypto.randomUUID(),
): TemplateBackup {
  const value =
    template.origin === 'builtin'
      ? {
          ...templateDefinition(template),
          id: uuid(),
          origin: 'custom' as const,
          createdAt: now,
          updatedAt: now,
          versions: [
            {
              id: uuid(),
              createdAt: now,
              kind: 'created' as const,
              snapshot: templateDefinition(template),
            },
          ],
        }
      : template;
  return templateBackupSchema.parse({
    format: 'productspy-templates',
    schemaVersion: 1,
    exportedAt: now,
    templates: [value],
  });
}
