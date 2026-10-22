import { z } from 'zod';
import {
  analysisUsageSchema,
  contentOptionsSchema,
  generationTokenUsageSchema,
  productSchema,
} from './schema';
import {
  aiTemplateSchema,
  CONTENT_FIELDS,
  contentFieldLabels,
  type ContentField,
} from './templates';
import { comparisonPlanSchema, comparisonEvidenceSchema } from './comparison';
import { buildProductMediaAssets, identifyMedia, canonicalMediaUrl } from './media';
import type { Product } from './types';

export { contentOptionsSchema } from './schema';
export type ContentOptions = z.infer<typeof contentOptionsSchema>;
export const DEFAULT_CONTENT_OPTIONS: ContentOptions = contentOptionsSchema.parse({});
export const MAX_CONTENT_PLANS = 200;
export const MAX_CONTENT_VERSIONS = 50;
export const MAX_CONTENT_BACKUP_BYTES = 25 * 1024 * 1024;
const item = z.string().trim().min(1).max(12000);
const list = z.array(item).min(1).max(30);
export const contentSelectedMediaSchema = z
  .array(
    z
      .object({
        kind: z.enum(['image', 'video']),
        url: z.string().url().max(4000),
      })
      .strict(),
  )
  .max(50)
  .refine(
    (selection) =>
      new Set(selection.map((asset) => `${asset.kind}:${canonicalMediaUrl(asset.url)}`)).size ===
      selection.length,
    '素材引用不能重复',
  );
export type ContentSelectedMedia = z.infer<typeof contentSelectedMediaSchema>;
export function contentMediaChoices(product: Product): ContentSelectedMedia {
  const choices = buildProductMediaAssets(product)
    .flatMap((asset) => [
      { kind: asset.kind, url: asset.url },
      ...asset.variants.map((variant) => ({ kind: asset.kind, url: variant.url })),
    ])
    .filter((asset) => identifyMedia(asset.url, asset.kind).downloadable);
  return choices.filter(
    (asset, index) =>
      choices.findIndex(
        (value) =>
          value.kind === asset.kind &&
          canonicalMediaUrl(value.url) === canonicalMediaUrl(asset.url),
      ) === index,
  );
}
/** One visible asset per captured media identity; keep every genuine quality source. */
export function contentMediaChoiceGroups(product: Product) {
  const allowed = new Set(
    contentMediaChoices(product).map((item) => `${item.kind}:${canonicalMediaUrl(item.url)}`),
  );
  return buildProductMediaAssets(product)
    .map((asset) => ({
      ...asset,
      variants: asset.variants.filter((variant) =>
        allowed.has(`${asset.kind}:${canonicalMediaUrl(variant.url)}`),
      ),
    }))
    .filter((asset) => asset.variants.length > 0);
}
export const contentOutputSchema = z
  .object({
    sellingCopy: list,
    shortVideoScript: list.refine(
      (parts) =>
        ['Hook', 'Problem', 'Solution', 'Demo', 'CTA'].every((label) =>
          new RegExp(`(?:^|\\n)${label}\\s*[:：]`, 'i').test(parts.join('\n')),
        ),
      '脚本需要 Hook / Problem / Solution / Demo / CTA 五段',
    ),
    hooks: list.min(5),
    storyboard: list,
    voiceover: list,
    titlesDescriptions: list,
    imagePrompts: list,
    videoPrompts: list,
    adAngles: list,
  })
  .strict();
export type ContentOutput = z.infer<typeof contentOutputSchema>;
export const textDurationEstimateSchema = z
  .object({
    method: z.literal('text-only-estimate'),
    requestedSeconds: z.number().int().min(5).max(180),
    spokenCharacters: z.number().int().nonnegative(),
    estimatedSeconds: z.number().finite().nonnegative(),
    warnings: z.array(z.string().max(1000)).max(20),
  })
  .strict();
export const contentMetadataSchema = z
  .object({
    mode: z.enum(['mock', 'real']),
    model: z.string().max(200).optional(),
    channelId: z.string().min(1).max(64).optional(),
    channelLabel: z.string().min(1).max(80).optional(),
    provider: z.string().min(1).max(64).optional(),
    options: contentOptionsSchema,
    generatedAt: z.string().datetime(),
    sourceUpdatedAt: z.string().datetime(),
    templateId: z.string().min(1).max(100),
    templateVersionId: z.string().min(1).max(100).optional(),
    productAnalysisReference: z
      .object({
        productId: z.string().min(1).max(100),
        asin: z.string().regex(/^[A-Z0-9]{10}$/),
        versionId: z.string().uuid().optional(),
        mode: z.enum(['mock', 'real', 'legacy', 'edited']),
        sourceUpdatedAt: z.string().datetime(),
        classification: z.literal('saved-analysis-unverified'),
      })
      .strict()
      .optional(),
    evidence: comparisonEvidenceSchema,
    usage: analysisUsageSchema.optional(),
    requestId: z.string().uuid().optional(),
    selectedFields: z.array(z.enum(CONTENT_FIELDS)).min(1).max(9).optional(),
    selectedMedia: contentSelectedMediaSchema.optional(),
    textDurationEstimate: textDurationEstimateSchema,
  })
  .strict();
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;
export const contentVersionSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    kind: z.enum(['generated', 'edited', 'restored']),
    output: contentOutputSchema,
    metadata: contentMetadataSchema.optional(),
    restoredFrom: z.string().uuid().optional(),
    parentVersionId: z.string().uuid().optional(),
    archivedParentVersionId: z.string().uuid().optional(),
    archivedParentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type ContentVersion = z.infer<typeof contentVersionSchema>;
export const contentPlanSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    productId: z.string().min(1).max(100),
    productSnapshot: productSchema.strict(),
    templateSnapshot: aiTemplateSchema,
    comparisonSource: comparisonPlanSchema.optional(),
    selectedMedia: contentSelectedMediaSchema.optional(),
    options: contentOptionsSchema,
    status: z.enum(['draft', 'needs-edit', 'completed']),
    favorite: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    currentVersionId: z.string().uuid().optional(),
    versions: z.array(contentVersionSchema).max(MAX_CONTENT_VERSIONS),
  })
  .strict()
  .superRefine((plan, context) => {
    const ids = plan.versions.map((version) => version.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: '内容版本编号重复' });
    if (plan.currentVersionId && !ids.includes(plan.currentVersionId))
      context.addIssue({ code: 'custom', message: '当前内容版本不存在' });
    if (plan.versions.length && !plan.currentVersionId)
      context.addIssue({ code: 'custom', message: '已有内容历史时必须选择当前版本' });
    if (plan.productSnapshot.id !== plan.productId)
      context.addIssue({ code: 'custom', message: '商品来源编号不一致' });
    const allowedMedia = new Set(
      contentMediaChoices(plan.productSnapshot).map(
        (asset) => `${asset.kind}:${canonicalMediaUrl(asset.url)}`,
      ),
    );
    for (const selection of [
      plan.selectedMedia,
      ...plan.versions.map((version) => version.metadata?.selectedMedia),
    ])
      if (
        selection?.some(
          (asset) => !allowedMedia.has(`${asset.kind}:${canonicalMediaUrl(asset.url)}`),
        )
      )
        context.addIssue({
          code: 'custom',
          message: '只能选择此商品快照中来源匹配且域名安全的图片或 MP4 / WebM 视频',
        });
    if (
      plan.comparisonSource &&
      (!plan.comparisonSource.analysis ||
        !plan.comparisonSource.products.some(
          (product) =>
            product.id === plan.productId &&
            product.sourceId === plan.productSnapshot.sourceId &&
            product.source === plan.productSnapshot.source,
        ))
    )
      context.addIssue({
        code: 'custom',
        message: '只能引用包含同一 ASIN 商品且有已保存分析的对比方案',
      });
    const seen = new Set<string>();
    const templateVersions = new Set(plan.templateSnapshot.versions.map((version) => version.id));
    for (const version of plan.versions) {
      if (
        Boolean(version.archivedParentVersionId) !== Boolean(version.archivedParentSha256) ||
        (version.archivedParentVersionId && version.parentVersionId)
      )
        context.addIssue({
          code: 'custom',
          message: '已归档父版本编号和摘要必须成对保存，且不能同时保留父版本引用',
        });
      if (version.parentVersionId && !seen.has(version.parentVersionId))
        context.addIssue({ code: 'custom', message: '内容父版本必须是本方案先前保存的版本' });
      if (version.restoredFrom && !seen.has(version.restoredFrom))
        context.addIssue({ code: 'custom', message: '恢复来源必须是本方案先前保存的版本' });
      const reference = version.metadata?.productAnalysisReference;
      if (
        reference &&
        (!plan.productSnapshot.aiAnalysis ||
          reference.productId !== plan.productId ||
          reference.asin !== plan.productSnapshot.sourceId ||
          (reference.versionId &&
            !plan.productSnapshot.analysisHistory?.some((item) => item.id === reference.versionId)))
      )
        context.addIssue({
          code: 'custom',
          message: '商品分析引用与保存的商品身份或分析版本不一致',
        });
      if (
        version.metadata &&
        (version.metadata.templateId !== plan.templateSnapshot.id ||
          (version.metadata.templateVersionId &&
            !templateVersions.has(version.metadata.templateVersionId)) ||
          version.metadata.sourceUpdatedAt !== plan.productSnapshot.updatedAt)
      )
        context.addIssue({ code: 'custom', message: '生成元数据与保存的商品或模板来源不一致' });
      seen.add(version.id);
    }
  });
export type ContentPlan = z.infer<typeof contentPlanSchema>;
export const contentFileSchema = z
  .object({ schemaVersion: z.literal(1), plans: z.array(contentPlanSchema).max(MAX_CONTENT_PLANS) })
  .strict()
  .refine(
    (file) => new Set(file.plans.map((plan) => plan.id)).size === file.plans.length,
    '内容方案编号重复',
  );
export const contentBackupSchema = z
  .object({
    format: z.literal('productspy-content'),
    schemaVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    plans: z.array(contentPlanSchema).max(MAX_CONTENT_PLANS),
  })
  .strict()
  .refine(
    (file) => new Set(file.plans.map((plan) => plan.id)).size === file.plans.length,
    '内容方案编号重复',
  );
export const contentGenerationSchema = z
  .object({
    output: contentOutputSchema,
    evidence: comparisonEvidenceSchema,
    usage: generationTokenUsageSchema.optional(),
  })
  .strict();
export type ContentGenerationResult = z.infer<typeof contentGenerationSchema>;
export interface ContentGenerationResponse {
  plan: ContentPlan;
  version: ContentVersion;
  requestId: string;
  replayed: boolean;
}
export * from './content-references';
export function currentContentVersion(plan: ContentPlan): ContentVersion | undefined {
  return plan.versions.find((version) => version.id === plan.currentVersionId);
}
export function estimateContentDuration(
  output: ContentOutput,
  options: ContentOptions,
): z.infer<typeof textDurationEstimateSchema> {
  // A text heuristic, never measured audio or filming duration. Voiceover excludes storyboard instructions.
  const speech = output.voiceover.join(' ').trim();
  const characters = [...speech].length;
  const units = options.language === 'en' ? speech.split(/\s+/).filter(Boolean).length : characters;
  const estimatedSeconds = Math.round((units / (options.language === 'en' ? 2.3 : 4.2)) * 10) / 10;
  const warnings = ['仅按口播文本量估算，未合成语音或测量拍摄时长；请试读并人工调整。'];
  if (estimatedSeconds > options.duration * 1.4)
    warnings.push('口播文本可能超过所选时长；建议缩短内容或延长视频。');
  if (estimatedSeconds < options.duration * 0.35)
    warnings.push('口播文本较短；镜头演示与停顿时间需要人工安排。');
  return {
    method: 'text-only-estimate',
    requestedSeconds: options.duration,
    spokenCharacters: characters,
    estimatedSeconds,
    warnings,
  };
}
function safeText(value: string): string {
  return value.replace(/[\\`*_{}[\]<>()#+.!|]/g, '\\$&');
}
function exportedVersion(plan: ContentPlan, versionId?: string): ContentVersion | undefined {
  return versionId
    ? plan.versions.find((version) => version.id === versionId)
    : currentContentVersion(plan);
}
export function contentExportFilename(plan: ContentPlan, extension: string): string {
  const name =
    plan.name
      .normalize('NFKC')
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\.{2,}/g, '_')
      .replace(/[. ]+$/, '')
      .slice(0, 60) || 'content';
  const cleanExtension = extension.replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'txt';
  return `${name}-${plan.productSnapshot.sourceId}-${plan.id.slice(0, 8)}.${cleanExtension}`;
}
export function exportContentMarkdown(
  plan: ContentPlan,
  fields: readonly ContentField[] = CONTENT_FIELDS,
  versionId?: string,
): string {
  const version = exportedVersion(plan, versionId);
  const lines = [
    `# ${safeText(plan.name)}`,
    '',
    `商品：${safeText(plan.productSnapshot.title)}`,
    `ASIN：${plan.productSnapshot.sourceId}`,
    `来源：${plan.productSnapshot.url}`,
    `商品采集时间：${plan.productSnapshot.updatedAt}（历史记录，非实时）`,
    `模板：${safeText(plan.templateSnapshot.name)} · ${plan.templateSnapshot.id}`,
    `内容版本：${version?.id ?? '尚未生成'}`,
    `状态：${plan.status}`,
    '',
    version?.metadata?.mode === 'real'
      ? '真实 AI 生成 / 人工编辑；需人工核查。'
      : 'Mock 本机示例 / 人工编辑；未验证真实模型质量。',
    '',
    '卖点与规格属于商家页面宣称；未分析评论正文，未观看或上传图片视频。',
  ];
  if (version)
    for (const field of fields)
      lines.push(
        '',
        `## ${contentFieldLabels[field]}`,
        '',
        ...version.output[field].map((text) => safeText(text)),
      );
  lines.push(
    '',
    '## 生成参数',
    '',
    '```json',
    JSON.stringify(version?.metadata?.options ?? plan.options, null, 2),
    '```',
  );
  if (plan.comparisonSource)
    lines.push(
      '',
      `引用对比：${safeText(plan.comparisonSource.name)} · ${plan.comparisonSource.id} · ${plan.comparisonSource.updatedAt}（已保存快照，推断仍需核实）`,
    );
  const selectedMedia = version
    ? (version.metadata?.selectedMedia ?? [])
    : (plan.selectedMedia ?? []);
  lines.push(
    '',
    '## 引用素材（仅来源记录，未复制或上传媒体）',
    '',
    ...selectedMedia.map(
      (asset, index) =>
        `${index + 1}. ${asset.kind === 'image' ? '图片' : '视频'} · ASIN ${plan.productSnapshot.sourceId} · ${safeText(asset.url)}`,
    ),
  );
  if (!selectedMedia.length) lines.push('该内容版本没有已记录的素材选择。');
  if (version?.metadata)
    for (const [key, label] of [
      ['facts', '页面采集事实'],
      ['merchantClaims', '商家宣称'],
      ['inferences', 'AI 推断'],
      ['unknowns', '未知与待验证'],
    ] as const)
      lines.push(
        '',
        `## ${label}`,
        '',
        ...version.metadata.evidence[key].map((text) => `- ${safeText(text)}`),
      );
  return lines.join('\n');
}
export function exportContentTxt(
  plan: ContentPlan,
  fields: readonly ContentField[] = CONTENT_FIELDS,
  versionId?: string,
): string {
  return exportContentMarkdown(plan, fields, versionId)
    .replace(/\\([\\`*_{}[\]<>()#+.!|])/g, '$1')
    .replace(/^#{1,3}\s/gm, '')
    .replace(/^```(?:json)?\s*$/gm, '');
}
export const exportContentText = exportContentTxt;
export function exportContentJson(
  plan: ContentPlan,
  fields: readonly ContentField[] = CONTENT_FIELDS,
  versionId?: string,
): string {
  const version = exportedVersion(plan, versionId);
  return JSON.stringify(
    {
      format: 'productspy-content-export',
      schemaVersion: 1,
      planId: plan.id,
      name: plan.name,
      product: plan.productSnapshot,
      template: plan.templateSnapshot,
      ...(plan.comparisonSource ? { comparisonSource: plan.comparisonSource } : {}),
      versionId: version?.id,
      output: version
        ? Object.fromEntries(fields.map((field) => [field, version.output[field]]))
        : {},
      metadata: version?.metadata,
      selectedMedia: version ? (version.metadata?.selectedMedia ?? []) : (plan.selectedMedia ?? []),
      options: version?.metadata?.options ?? plan.options,
      disclaimer: '历史页面资料；商家宣称与 AI 推断需人工验证。未上传或复制媒体，未分析评论正文。',
    },
    null,
    2,
  );
}
