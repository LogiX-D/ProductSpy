import { z } from 'zod';
import {
  analysisOptionsSchema,
  analysisPricingSchema,
  analysisUsageRecordSchema,
  contentOptionsSchema,
  productSchema,
} from './schema';
import {
  libraryDefinitionSchema,
  MAX_LIBRARY_PRODUCTS,
  MAX_LIBRARY_GROUPS,
  MAX_LIBRARY_TAGS,
  validateLibraryRelations,
} from './library';
import { parseLibraryImport } from './library-transfer';
import { comparisonFileSchema, type ComparisonPlan } from './comparison';
import { templateFileSchema, builtinTemplates } from './templates';
import { contentFileSchema } from './content';
import type { Product } from './types';

export const MAX_WORKSPACE_BACKUP_BYTES = 100 * 1024 * 1024;
export const MAX_WORKSPACE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_WORKSPACE_USAGE_RECORDS = 50000;
export const workspaceUsageRecordSchema = analysisUsageRecordSchema
  .extend({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    versionId: z.string().min(1).max(100).optional(),
    errorCode: z.number().int().optional(),
    cooldownUntil: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (record) => Boolean(record.options) !== Boolean(record.contentOptions),
    '用量记录需要且仅允许一种生成参数',
  );
export const workspaceUsageSchema = z
  .array(workspaceUsageRecordSchema)
  .max(MAX_WORKSPACE_USAGE_RECORDS)
  .refine(
    (records) => new Set(records.map((record) => record.requestId)).size === records.length,
    '用量请求编号重复',
  );
const definitionFilter = z.union([z.literal('all'), z.literal('none'), z.string().uuid()]);
export const workspacePreferencesSchema = z
  .object({
    library: z
      .object({
        query: z.string().max(500),
        source: z.enum(['all', 'amazon']),
        analysis: z.enum(['all', 'pending', 'analyzed']),
        sort: z.enum(['updated-desc', 'collected-desc', 'collected-asc', 'title-asc']),
        layout: z.enum(['grid', 'list']),
        group: definitionFilter,
        tag: definitionFilter,
      })
      .strict()
      .optional(),
    analysis: z
      .object({
        version: z.literal(1),
        options: analysisOptionsSchema.strict(),
        pricing: analysisPricingSchema.partial().strict(),
      })
      .strict()
      .optional(),
    content: z
      .object({
        version: z.literal(1),
        options: contentOptionsSchema,
        pricing: analysisPricingSchema.partial().strict(),
      })
      .strict()
      .optional(),
    builtinFavorites: z
      .array(z.enum(builtinTemplates.map((template) => template.id) as [string, ...string[]]))
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();
export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>;
const workspaceLibrarySchema = z
  .object({
    products: z.array(productSchema.strict()).max(MAX_LIBRARY_PRODUCTS),
    groups: z.array(libraryDefinitionSchema.strict()).max(MAX_LIBRARY_GROUPS),
    tags: z.array(libraryDefinitionSchema.strict()).max(MAX_LIBRARY_TAGS),
  })
  .strict();
export const workspaceBackupSchema = z
  .object({
    format: z.literal('productspy-workspace'),
    schemaVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    library: workspaceLibrarySchema,
    comparisons: comparisonFileSchema.innerType().shape.plans,
    templates: templateFileSchema.shape.templates,
    contentPlans: contentFileSchema.innerType().shape.plans,
    usage: workspaceUsageSchema,
    preferences: workspacePreferencesSchema.optional(),
  })
  .strict();
export type WorkspaceBackup = z.infer<typeof workspaceBackupSchema>;
export interface WorkspaceBackupCounts {
  products: number;
  groups: number;
  tags: number;
  comparisons: number;
  templates: number;
  contentPlans: number;
  usage: number;
  histories: number;
}
export interface WorkspaceBackupPreview {
  revision: string;
  counts: WorkspaceBackupCounts;
  conflicts: {
    kind: 'product' | 'comparison' | 'template' | 'content' | 'usage';
    id: string;
    label: string;
  }[];
  warnings: string[];
}
export function workspaceBackupCounts(backup: WorkspaceBackup): WorkspaceBackupCounts {
  return {
    products: backup.library.products.length,
    groups: backup.library.groups.length,
    tags: backup.library.tags.length,
    comparisons: backup.comparisons.length,
    templates: backup.templates.length,
    contentPlans: backup.contentPlans.length,
    usage: backup.usage.length,
    histories:
      backup.library.products.reduce((n, item) => n + (item.analysisHistory?.length ?? 0), 0) +
      backup.comparisons.reduce((n, item) => n + (item.analysisHistory?.length ?? 0), 0) +
      backup.templates.reduce((n, item) => n + item.versions.length, 0) +
      backup.contentPlans.reduce((n, item) => n + item.versions.length, 0),
  };
}
/** Verify all nested page/media URLs even when the live product/template has already been deleted. */
export function validateWorkspaceRelations(
  backup: WorkspaceBackup,
  previous?: WorkspaceBackup,
): void {
  validateLibraryRelations(backup.library);
  const identities = new Map<string, string>();
  const validateProduct = (product: Product): void => {
    parseLibraryImport([{ ...product, groupIds: [], tagIds: [] }]);
    const identity = `${product.source}:${product.sourceId}`;
    const existing = identities.get(product.id);
    if (existing && existing !== identity)
      throw new Error('同一商品 ID 指向不同 ASIN，恢复已取消；请检查备份来源');
    identities.set(product.id, identity);
  };
  const validateComparison = (plan: ComparisonPlan): void => {
    plan.products.forEach(validateProduct);
  };
  const validateAll = (value: WorkspaceBackup): void => {
    value.library.products.forEach(validateProduct);
    value.comparisons.forEach(validateComparison);
    for (const plan of value.contentPlans) {
      validateProduct(plan.productSnapshot);
      if (plan.comparisonSource) validateComparison(plan.comparisonSource);
      if (
        plan.templateSnapshot.origin === 'builtin' &&
        !builtinTemplates.some((template) => template.id === plan.templateSnapshot.id)
      )
        throw new Error('内容方案引用了未知的内置模板编号');
    }
  };
  if (previous) validateAll(previous);
  validateAll(backup);
}
export function workspaceFileContents(backup: WorkspaceBackup): Record<string, string> {
  return {
    'products.json': JSON.stringify({ schemaVersion: 2, ...backup.library }, null, 2),
    'comparisons.json': JSON.stringify(
      comparisonFileSchema.parse({ schemaVersion: 1, plans: backup.comparisons }),
      null,
      2,
    ),
    'templates.json': JSON.stringify(
      templateFileSchema.parse({ schemaVersion: 1, templates: backup.templates }),
      null,
      2,
    ),
    'content-plans.json': JSON.stringify(
      contentFileSchema.parse({ schemaVersion: 1, plans: backup.contentPlans }),
      null,
      2,
    ),
    'analysis-usage.json': JSON.stringify(backup.usage, null, 2),
  };
}
/** Strict allowlisted format: credential/config/session fields are rejected rather than copied. */
export function parseWorkspaceBackup(value: unknown): WorkspaceBackup {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error('备份不是有效的 JSON');
  }
  if (!text || new TextEncoder().encode(text).byteLength > MAX_WORKSPACE_BACKUP_BYTES)
    throw new Error('完整业务备份不能超过 100 MiB');
  const parsed = workspaceBackupSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `完整业务备份结构、版本或引用无效：${parsed.error.issues[0]?.message ?? '未知字段'}`,
    );
  validateWorkspaceRelations(parsed.data);
  for (const contents of Object.values(workspaceFileContents(parsed.data)))
    if (new TextEncoder().encode(contents).byteLength > MAX_WORKSPACE_FILE_BYTES)
      throw new Error('单项业务资料超过 25 MiB，请使用独立备份分批整理；未覆盖原资料');
  return parsed.data;
}
export function parseWorkspaceBackupText(text: string): WorkspaceBackup {
  if (new TextEncoder().encode(text).byteLength > MAX_WORKSPACE_BACKUP_BYTES)
    throw new Error('完整业务备份不能超过 100 MiB');
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new Error('文件不是有效的 JSON，请检查备份是否完整');
  }
  return parseWorkspaceBackup(value);
}
/** Large backups use compact JSON when indentation would exceed the same import limit. */
export function serializeWorkspaceBackup(value: WorkspaceBackup): string {
  const checked = parseWorkspaceBackup(value);
  const pretty = JSON.stringify(checked, null, 2);
  return new TextEncoder().encode(pretty).byteLength <= MAX_WORKSPACE_BACKUP_BYTES
    ? pretty
    : JSON.stringify(checked);
}
