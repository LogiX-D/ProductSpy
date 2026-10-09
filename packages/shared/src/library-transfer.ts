import { z } from 'zod';
import {
  MAX_LIBRARY_GROUPS,
  MAX_LIBRARY_TAGS,
  libraryDefinitionSchema,
  librarySnapshotSchema,
  validateLibraryRelations,
} from './library';
import { productKey } from './product';
import { isAmazonProductUrl, productSchema } from './schema';
import type { LibraryDefinition, LibrarySnapshot, Product } from './types';

export const MAX_LIBRARY_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_LIBRARY_IMPORT_PRODUCTS = 2000;
export type LibraryImportPolicy = 'skip' | 'preserve';
export interface LibraryImportConflict {
  incomingId: string;
  existingId: string;
  sourceId: string;
  title: string;
}
export interface LibraryImportPreview {
  total: number;
  newProducts: number;
  conflicts: LibraryImportConflict[];
  reassignedIds: number;
  groups: number;
  tags: number;
  revision?: string;
}
export interface LibraryImportResult {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  importedIds: string[];
  skippedIds: string[];
  conflicts: LibraryImportConflict[];
  reassignedIds: number;
  groupsAdded: number;
  tagsAdded: number;
}
export interface LibraryExportFile {
  filename: string;
  mimeType: string;
  content: string;
  count: number;
}
const backupSchema = z
  .object({
    format: z.literal('productspy-library'),
    schemaVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    products: z.array(productSchema.strict()).max(MAX_LIBRARY_IMPORT_PRODUCTS),
    groups: z.array(libraryDefinitionSchema.strict()).max(MAX_LIBRARY_GROUPS),
    tags: z.array(libraryDefinitionSchema.strict()).max(MAX_LIBRARY_TAGS),
  })
  .strict();
function safeUrl(value: string, media: boolean): URL {
  // ASCII whitespace/control characters must be rejected before URL parsing can normalize them.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error('导入文件包含不安全的素材地址');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('导入文件包含格式无效的地址');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
    throw new Error('导入地址不允许凭据、自定义端口或不安全协议');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    media &&
    (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(hostname) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(hostname) ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === 'localtest.me' ||
      hostname.endsWith('.localtest.me') ||
      hostname.endsWith('.nip.io') ||
      hostname.endsWith('.sslip.io'))
  )
    throw new Error('素材地址必须是公开网站，不能使用 IP、本机或内网地址');
  return url;
}

function validateProductUrls(product: Product): void {
  const url = safeUrl(product.url, false);
  const asin = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1];
  if (!isAmazonProductUrl(product.url) || asin?.toUpperCase() !== product.sourceId)
    throw new Error('商品链接与 ASIN 不匹配，请检查导入文件');
  for (const image of [...product.images, ...(product.mainImage ? [product.mainImage] : [])])
    safeUrl(image, true);
  for (const video of product.videos) {
    safeUrl(video.url, true);
    if (video.thumbnail) safeUrl(video.thumbnail, true);
  }
  const versionIds = product.analysisHistory?.map((version) => version.id) ?? [];
  if (new Set(versionIds).size !== versionIds.length)
    throw new Error('商品分析历史包含重复的版本编号，请检查导入文件');
}

/** Entire-file validation: never silently discard a malformed record or an AI version. */
export function parseLibraryImport(value: unknown): LibrarySnapshot {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('导入数据不是有效的 JSON');
  }
  if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_LIBRARY_IMPORT_BYTES)
    throw new Error('导入文件不能超过 25 MiB');
  let snapshot: LibrarySnapshot;
  if (Array.isArray(value)) {
    const parsed = z
      .array(productSchema.strict())
      .max(MAX_LIBRARY_IMPORT_PRODUCTS)
      .safeParse(value);
    if (!parsed.success) throw new Error('旧版商品数组格式无效，或商品数量超过 2000 件');
    snapshot = { products: parsed.data, groups: [], tags: [] };
  } else {
    const parsed = backupSchema.safeParse(value);
    if (!parsed.success)
      throw new Error('请选择 ProductSpy JSON 资料或备份；格式、版本或商品结构无效');
    snapshot = {
      products: parsed.data.products,
      groups: parsed.data.groups,
      tags: parsed.data.tags,
    };
  }
  validateLibraryRelations(snapshot);
  snapshot.products.forEach(validateProductUrls);
  return snapshot;
}

export function parseLibraryImportText(text: string): LibrarySnapshot {
  if (new TextEncoder().encode(text).byteLength > MAX_LIBRARY_IMPORT_BYTES)
    throw new Error('导入文件不能超过 25 MiB');
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new Error('文件不是有效的 JSON；请检查文件是否完整');
  }
  return parseLibraryImport(value);
}

export function previewLibraryImport(
  incoming: LibrarySnapshot,
  existing: LibrarySnapshot,
): LibraryImportPreview {
  const keys = new Map(existing.products.map((product) => [productKey(product), product]));
  const ids = new Set(existing.products.map((product) => product.id));
  const conflicts: LibraryImportConflict[] = [];
  let reassignedIds = 0;
  for (const product of incoming.products) {
    const current = keys.get(productKey(product));
    if (current)
      conflicts.push({
        incomingId: product.id,
        existingId: current.id,
        sourceId: product.sourceId,
        title: product.title,
      });
    else if (ids.has(product.id)) reassignedIds++;
  }
  return {
    total: incoming.products.length,
    newProducts: incoming.products.length - conflicts.length,
    conflicts,
    reassignedIds,
    groups: incoming.groups.length,
    tags: incoming.tags.length,
    ...(existing.revision ? { revision: existing.revision } : {}),
  };
}

function mergeDefinitions(
  incoming: LibraryDefinition[],
  existing: LibraryDefinition[],
  uniqueId: () => string,
): { definitions: LibraryDefinition[]; mapping: Map<string, string>; added: number } {
  const definitions = [...existing];
  const ids = new Set(existing.map((item) => item.id));
  const names = new Map(existing.map((item) => [item.name.toLocaleLowerCase(), item]));
  const mapping = new Map<string, string>();
  for (const definition of incoming) {
    const matching = names.get(definition.name.toLocaleLowerCase());
    if (matching) {
      mapping.set(definition.id, matching.id);
      continue;
    }
    const id = ids.has(definition.id) ? uniqueId() : definition.id;
    const added = { ...definition, id };
    definitions.push(added);
    ids.add(id);
    names.set(added.name.toLocaleLowerCase(), added);
    mapping.set(definition.id, id);
  }
  return { definitions, mapping, added: definitions.length - existing.length };
}

/** Non-destructive restore. Both policies preserve every existing product byte-for-byte. */
export function mergeLibraryImport(
  incoming: LibrarySnapshot,
  existing: LibrarySnapshot,
  policy: LibraryImportPolicy,
  idFactory: () => string,
): { snapshot: LibrarySnapshot; result: LibraryImportResult } {
  if (policy !== 'skip' && policy !== 'preserve') throw new Error('请选择安全的重复商品处理方式');
  const preview = previewLibraryImport(incoming, existing);
  const occupied = new Set([
    ...existing.products.map((item) => item.id),
    ...incoming.products.map((item) => item.id),
    ...existing.groups.map((item) => item.id),
    ...existing.tags.map((item) => item.id),
    ...incoming.groups.map((item) => item.id),
    ...incoming.tags.map((item) => item.id),
  ]);
  const uniqueId = (): string => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = idFactory();
      if (!z.string().uuid().safeParse(id).success) throw new Error('无法生成有效的新商品编号');
      if (!occupied.has(id)) {
        occupied.add(id);
        return id;
      }
    }
    throw new Error('无法生成不重复的编号，请重试');
  };
  const groups = mergeDefinitions(incoming.groups, existing.groups, uniqueId);
  const tags = mergeDefinitions(incoming.tags, existing.tags, uniqueId);
  const skipped = new Set(preview.conflicts.map((item) => item.incomingId));
  const existingIds = new Set(existing.products.map((item) => item.id));
  const additions = incoming.products
    .filter((item) => !skipped.has(item.id))
    .map((item) => ({
      ...item,
      id: existingIds.has(item.id) ? uniqueId() : item.id,
      ...(item.groupIds
        ? { groupIds: item.groupIds.map((id) => groups.mapping.get(id) ?? id) }
        : {}),
      ...(item.tagIds ? { tagIds: item.tagIds.map((id) => tags.mapping.get(id) ?? id) } : {}),
    }));
  const snapshot = {
    products: [...existing.products, ...additions],
    groups: groups.definitions,
    tags: tags.definitions,
  };
  const validated = librarySnapshotSchema.safeParse(snapshot);
  if (!validated.success) throw new Error('合并后超出商品库、分组或标签容量；已有资料未修改');
  validateLibraryRelations(snapshot);
  return {
    snapshot,
    result: {
      total: preview.total,
      imported: additions.length,
      skipped: skipped.size,
      failed: 0,
      importedIds: additions.map((item) => item.id),
      skippedIds: [...skipped],
      conflicts: preview.conflicts,
      reassignedIds: preview.reassignedIds,
      groupsAdded: groups.added,
      tagsAdded: tags.added,
    },
  };
}

export function serializeLibraryBackup(snapshot: LibrarySnapshot): string {
  const content = JSON.stringify(
    {
      format: 'productspy-library',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      products: snapshot.products,
      groups: snapshot.groups,
      tags: snapshot.tags,
    },
    null,
    2,
  );
  // Every exported backup must be accepted by the same importer; large libraries use selections.
  parseLibraryImportText(content);
  return content;
}

/** Quote every field and neutralize spreadsheet formula evaluation, including leading controls. */
function csvCell(value: unknown): string {
  let text = value === undefined ? '' : String(value);
  // Hidden leading controls must not let an imported field become a spreadsheet formula.
  // eslint-disable-next-line no-control-regex
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function exportProductsCsv(products: Product[]): string {
  const header = [
    '商品编号',
    '来源',
    'ASIN',
    '标题',
    '价格',
    '货币',
    '品牌',
    '评分',
    '评论数量',
    '商品链接',
    'AI 状态',
    '采集时间',
    '更新时间',
  ];
  const rows = products.map((product) => [
    product.id,
    product.source,
    product.sourceId,
    product.title,
    product.price,
    product.currency,
    product.brand,
    product.rating,
    product.reviewCount,
    product.url,
    product.aiAnalysis ? '已分析' : '待分析',
    product.createdAt,
    product.updatedAt,
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function markdownText(value: string): string {
  return value
    .replaceAll('\r', '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
export function exportAnalysesMarkdown(products: Product[]): string {
  const sections: [keyof NonNullable<Product['aiAnalysis']>, string][] = [
    ['summary', '商品总结'],
    ['sellingPoints', '核心卖点'],
    ['targetAudience', '目标用户'],
    ['purchaseMotivations', '购买动机'],
    ['painPoints', '潜在痛点'],
    ['strengths', '商品优势'],
    ['weaknesses', '待验证弱点'],
    ['marketingAngles', '营销角度'],
    ['hooks', '视频开场文案'],
    ['shortVideoScript', '短视频脚本'],
    ['imagePrompts', '图片生成提示词'],
    ['videoPrompts', '视频生成提示词'],
  ];
  return products
    .map((product) => {
      const lines = [
        `# ${markdownText(product.title)}`,
        '',
        `ASIN：${markdownText(product.sourceId)}`,
        '',
      ];
      if (!product.aiAnalysis) return [...lines, '尚未保存 AI 分析。', ''].join('\n');
      if (product.analysisMetadata)
        lines.push(
          `分析来源：${product.analysisMetadata.mode === 'mock' ? 'Mock 演示' : product.analysisMetadata.mode === 'real' ? '真实 AI' : '旧版分析'}`,
          '',
          '以下包含 AI 推断，未分析真实评论正文。',
          '',
        );
      for (const [field, label] of sections) {
        const value = product.aiAnalysis[field];
        lines.push(
          `## ${label}`,
          '',
          ...(Array.isArray(value)
            ? value.map((item) => `- ${markdownText(item)}`)
            : [markdownText(value)]),
          '',
        );
      }
      return lines.join('\n');
    })
    .join('\n---\n\n');
}
