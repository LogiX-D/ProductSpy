import { z } from 'zod';
import { productSchema } from './schema';
import type { LibrarySnapshot } from './types';

export const MAX_LIBRARY_PRODUCTS = 10000;
export const MAX_LIBRARY_GROUPS = 200;
export const MAX_LIBRARY_TAGS = 300;
export const MAX_MEMBERSHIPS = 50;
export const MAX_BATCH_PRODUCTS = 500;
export const definitionNameSchema = z.string().trim().min(1).max(48);
export const definitionColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, '颜色需要 #RRGGBB 格式');
export const libraryDefinitionSchema = z.object({
  id: z.string().uuid(),
  name: definitionNameSchema,
  color: definitionColorSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const librarySnapshotSchema = z.object({
  products: z.array(productSchema).max(MAX_LIBRARY_PRODUCTS),
  groups: z.array(libraryDefinitionSchema).max(MAX_LIBRARY_GROUPS),
  tags: z.array(libraryDefinitionSchema).max(MAX_LIBRARY_TAGS),
  revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const libraryFileSchema = librarySnapshotSchema.omit({ revision: true }).extend({
  schemaVersion: z.literal(2),
});
export const libraryDefinitionRequestSchema = z
  .object({
    kind: z.enum(['group', 'tag']),
    action: z.enum(['create', 'rename', 'delete']),
    id: z.string().uuid().optional(),
    name: definitionNameSchema.optional(),
    color: definitionColorSchema.optional(),
    confirmed: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action !== 'create' && !value.id)
      context.addIssue({ code: z.ZodIssueCode.custom, message: '缺少分组或标签编号' });
    if (value.action === 'create' && !value.name)
      context.addIssue({ code: z.ZodIssueCode.custom, message: '请输入分组或标签名称' });
    if (value.action === 'rename' && !value.name && !value.color)
      context.addIssue({ code: z.ZodIssueCode.custom, message: '请输入名称或选择颜色' });
    if (value.action === 'delete' && value.confirmed !== true)
      context.addIssue({ code: z.ZodIssueCode.custom, message: '请确认删除分组或标签' });
  });
export const libraryBatchRequestSchema = z
  .object({
    ids: z.array(z.string().min(1).max(100)).min(1).max(MAX_BATCH_PRODUCTS),
    operation: z.enum([
      'add-tags',
      'remove-tags',
      'add-groups',
      'remove-groups',
      'move-group',
      'delete',
    ]),
    tagIds: z.array(z.string().uuid()).min(1).max(MAX_MEMBERSHIPS).optional(),
    groupIds: z.array(z.string().uuid()).min(1).max(MAX_MEMBERSHIPS).optional(),
    expectedUpdatedAt: z.record(z.string().datetime()).optional(),
    confirmed: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.ids).size !== value.ids.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: '所选商品不能重复' });
    if (value.operation.includes('tags') && !value.tagIds?.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: '请选择至少一个标签' });
    if (
      (value.operation.includes('groups') || value.operation === 'move-group') &&
      !value.groupIds?.length
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: '请选择至少一个分组' });
    if (value.operation === 'move-group' && value.groupIds?.length !== 1)
      context.addIssue({ code: z.ZodIssueCode.custom, message: '移动商品需要选择一个目标分组' });
    if (
      ['delete', 'move-group', 'remove-tags', 'remove-groups'].includes(value.operation) &&
      value.confirmed !== true
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: '请确认此批量操作' });
  });
export const libraryBatchResultSchema = z.object({
  succeededIds: z.array(z.string()),
  failures: z.array(z.object({ id: z.string(), error: z.string() })),
  products: z.array(productSchema).optional(),
});

/** Reject inconsistent snapshots rather than dropping records during import or recovery. */
export function validateLibraryRelations(snapshot: LibrarySnapshot): void {
  for (const definitions of [snapshot.groups, snapshot.tags]) {
    if (new Set(definitions.map((item) => item.id)).size !== definitions.length)
      throw new Error('分组或标签编号重复');
    if (
      new Set(definitions.map((item) => item.name.toLocaleLowerCase())).size !== definitions.length
    )
      throw new Error('分组或标签名称重复');
  }
  const keys = snapshot.products.map((product) => `${product.source}:${product.sourceId}`);
  if (
    new Set(keys).size !== keys.length ||
    new Set(snapshot.products.map((product) => product.id)).size !== snapshot.products.length
  )
    throw new Error('商品编号或 ASIN 重复');
  const groups = new Set(snapshot.groups.map((item) => item.id));
  const tags = new Set(snapshot.tags.map((item) => item.id));
  for (const product of snapshot.products) {
    for (const [memberships, definitions] of [
      [product.groupIds ?? [], groups],
      [product.tagIds ?? [], tags],
    ] as const) {
      if (new Set(memberships).size !== memberships.length)
        throw new Error('商品的分组或标签不能重复');
      if (memberships.some((id) => !definitions.has(id)))
        throw new Error('商品引用了不存在的分组或标签');
    }
  }
}
