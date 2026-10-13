import { z } from 'zod';
import { analysisOptionsSchema, analysisUsageSchema, productSchema } from './schema';
import type { AnalysisOptions, AnalysisUsage, GenerationTokenUsage, Product } from './types';

export const COMPARISON_FIELDS = [
  'coreDifferences',
  'verifiableSellingPoints',
  'audienceDifferences',
  'opportunities',
  'contentAngles',
  'videoRecommendations',
  'risks',
] as const;
export type ComparisonField = (typeof COMPARISON_FIELDS)[number];
export type ComparisonAnalysis = Record<ComparisonField, string[]>;
export interface ComparisonEvidence {
  facts: string[];
  merchantClaims: string[];
  inferences: string[];
  unknowns: string[];
  reviewTextAnalyzed: false;
}
export interface ComparisonGenerationResult {
  analysis: ComparisonAnalysis;
  evidence: ComparisonEvidence;
  usage?: GenerationTokenUsage;
}
export interface ComparisonAnalysisMetadata {
  mode: 'mock' | 'real';
  model?: string;
  options: AnalysisOptions;
  generatedAt: string;
  sourceUpdatedAt: string;
  evidence: ComparisonEvidence;
  usage?: AnalysisUsage;
  requestId?: string;
}
export interface ComparisonAnalysisVersion {
  id: string;
  createdAt: string;
  kind: 'generated' | 'edited' | 'restored';
  analysis: ComparisonAnalysis;
  metadata?: ComparisonAnalysisMetadata;
  restoredFrom?: string;
}
export interface ComparisonPlan {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  snapshotUpdatedAt?: string;
  products: Product[];
  analysis?: ComparisonAnalysis;
  analysisMetadata?: ComparisonAnalysisMetadata;
  analysisHistory?: ComparisonAnalysisVersion[];
}
export interface ComparisonGenerationResponse {
  plan: ComparisonPlan;
  analysis: ComparisonAnalysis;
  metadata: ComparisonAnalysisMetadata;
  requestId: string;
  replayed: boolean;
}
export const MAX_COMPARISON_PLANS = 200;
export const MAX_COMPARISON_VERSIONS = 50;
export const MAX_COMPARISON_BACKUP_BYTES = 25 * 1024 * 1024;
const text = z.string().trim().min(1).max(12000);
const list = z.array(text).min(1).max(30);
export const comparisonAnalysisSchema = z
  .object({
    coreDifferences: list,
    verifiableSellingPoints: list,
    audienceDifferences: list,
    opportunities: list,
    contentAngles: list,
    videoRecommendations: list,
    risks: list,
  })
  .strict();
const evidenceList = z.array(text).max(30);
export const comparisonEvidenceSchema = z
  .object({
    facts: evidenceList,
    merchantClaims: evidenceList,
    inferences: evidenceList,
    unknowns: evidenceList,
    reviewTextAnalyzed: z.literal(false),
  })
  .strict();
export const comparisonGenerationSchema = z
  .object({
    analysis: comparisonAnalysisSchema,
    evidence: comparisonEvidenceSchema,
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().max(1000000000).optional(),
        outputTokens: z.number().int().nonnegative().max(1000000000).optional(),
      })
      .optional(),
  })
  .strict();
export const comparisonMetadataSchema = z
  .object({
    mode: z.enum(['mock', 'real']),
    model: z.string().max(200).optional(),
    options: analysisOptionsSchema,
    generatedAt: z.string().datetime(),
    sourceUpdatedAt: z.string().datetime(),
    evidence: comparisonEvidenceSchema,
    usage: analysisUsageSchema.optional(),
    requestId: z.string().uuid().optional(),
  })
  .strict();
export const comparisonAnalysisMetadataSchema = comparisonMetadataSchema;
export const comparisonVersionSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    kind: z.enum(['generated', 'edited', 'restored']),
    analysis: comparisonAnalysisSchema,
    metadata: comparisonMetadataSchema.optional(),
    restoredFrom: z.string().uuid().optional(),
  })
  .strict();
export const comparisonProductsSchema = z
  .array(productSchema.strict())
  .min(2)
  .max(5)
  .refine(
    (products) =>
      new Set(products.map((product) => `${product.source}:${product.sourceId}`)).size ===
        products.length && new Set(products.map((product) => product.id)).size === products.length,
    '请选择 2–5 个不同 ASIN 的商品',
  );
export const comparisonPlanSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    snapshotUpdatedAt: z.string().datetime().optional(),
    products: comparisonProductsSchema,
    analysis: comparisonAnalysisSchema.optional(),
    analysisMetadata: comparisonMetadataSchema.optional(),
    analysisHistory: z.array(comparisonVersionSchema).max(MAX_COMPARISON_VERSIONS).optional(),
  })
  .strict()
  .superRefine((plan, context) => {
    const ids = plan.analysisHistory?.map((version) => version.id) ?? [];
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: '对比分析历史版本编号重复' });
    if (plan.analysisMetadata && !plan.analysis)
      context.addIssue({ code: 'custom', message: '分析元数据缺少分析内容' });
  });
export const comparisonFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    plans: z.array(comparisonPlanSchema).max(MAX_COMPARISON_PLANS),
  })
  .strict()
  .refine(
    (file) => new Set(file.plans.map((plan) => plan.id)).size === file.plans.length,
    '对比方案编号重复',
  );
export const comparisonBackupSchema = z
  .object({
    format: z.literal('productspy-comparisons'),
    schemaVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    plans: z.array(comparisonPlanSchema).max(MAX_COMPARISON_PLANS),
  })
  .strict()
  .refine(
    (file) => new Set(file.plans.map((plan) => plan.id)).size === file.plans.length,
    '对比方案编号重复',
  );

export interface ComparisonRow {
  key: string;
  label: string;
  values: string[];
  different: boolean;
}
export function amazonCountry(product: Pick<Product, 'url'>): string {
  try {
    const suffix = new URL(product.url).hostname
      .replace(/^(?:www|smile)\./, '')
      .replace(/^amazon\./, '')
      .toLowerCase();
    const countries: Record<string, string> = {
      com: '美国 (US)',
      'co.uk': '英国 (UK)',
      de: '德国 (DE)',
      fr: '法国 (FR)',
      it: '意大利 (IT)',
      es: '西班牙 (ES)',
      'co.jp': '日本 (JP)',
      ca: '加拿大 (CA)',
      'com.au': '澳大利亚 (AU)',
      in: '印度 (IN)',
      'com.mx': '墨西哥 (MX)',
      'com.br': '巴西 (BR)',
      nl: '荷兰 (NL)',
      se: '瑞典 (SE)',
      pl: '波兰 (PL)',
      'com.be': '比利时 (BE)',
      ie: '爱尔兰 (IE)',
      ae: '阿联酋 (AE)',
      sa: '沙特阿拉伯 (SA)',
      'com.tr': '土耳其 (TR)',
      sg: '新加坡 (SG)',
    };
    return countries[suffix] ?? suffix.toUpperCase();
  } catch {
    return '未知';
  }
}
function specifications(product: Product): string {
  return product.specifications?.length
    ? product.specifications.map((item) => `${item.name}：${item.value}`).join('\n')
    : '未知（未采集页面规格）';
}
export function comparisonRows(products: Product[]): ComparisonRow[] {
  const definitions: [string, string, (product: Product) => string][] = [
    ['title', '商品名称', (p) => p.title],
    ['brand', '品牌', (p) => p.brand ?? '未知'],
    ['asin', 'ASIN', (p) => p.sourceId],
    ['country', 'Amazon 国家站', amazonCountry],
    ['price', '页面采集价格（非实时）', (p) => p.price ?? '未知'],
    ['currency', '货币', (p) => p.currency ?? '未知'],
    ['rating', '页面评分', (p) => (p.rating === undefined ? '未知' : String(p.rating))],
    [
      'reviews',
      '页面评论数量（无正文）',
      (p) => (p.reviewCount === undefined ? '未知' : String(p.reviewCount)),
    ],
    [
      'bullets',
      '页面宣称的卖点',
      (p) => (p.bulletPoints.length ? p.bulletPoints.join('\n') : '未知'),
    ],
    ['specifications', '页面列出的规格（商家信息）', specifications],
    [
      'images',
      '图片数量',
      (p) => String(new Set([...(p.mainImage ? [p.mainImage] : []), ...p.images]).size),
    ],
    ['videos', '视频数量', (p) => String(p.videos.length)],
    ['captured', '页面采集 / 更新于', (p) => p.updatedAt],
  ];
  return definitions.map(([key, label, value]) => {
    const values = products.map(value);
    return { key, label, values, different: new Set(values).size > 1 };
  });
}
function csv(value: string): string {
  const guarded = /^[\s]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}
function markdown(value: string): string {
  return value.replace(/[\\`*_{}[\]<>()#+.!|]/g, '\\$&').replace(/\r?\n/g, ' / ');
}
export function exportComparisonCsv(plan: ComparisonPlan): string {
  return (
    '\ufeff' +
    [
      ['字段', ...plan.products.map((p) => p.sourceId)],
      ...comparisonRows(plan.products).map((row) => [row.label, ...row.values]),
    ]
      .map((row) => row.map(csv).join(','))
      .join('\r\n')
  );
}
export function exportComparisonMarkdown(plan: ComparisonPlan): string {
  const rows = comparisonRows(plan.products);
  const result = [
    `# ${markdown(plan.name)}`,
    '',
    `方案保存于：${plan.updatedAt}`,
    '',
    '价格为历史页面采集值。不同货币不排序、不换算。卖点及规格属于商家页面资料；未分析真实评论正文。',
    '',
    `| 字段 | ${plan.products.map((p) => markdown(p.sourceId)).join(' | ')} |`,
    `| --- | ${plan.products.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${markdown(row.label)} | ${row.values.map(markdown).join(' | ')} |`),
  ];
  if (plan.analysis) {
    result.push(
      '',
      `## AI 对比分析（${plan.analysisMetadata?.mode === 'real' ? '真实 AI，需人工核查' : 'Mock / 人工编辑示例'}）`,
    );
    for (const field of COMPARISON_FIELDS)
      result.push(
        '',
        `### ${comparisonFieldLabels[field]}`,
        '',
        ...plan.analysis[field].map((item) => `- ${markdown(item)}`),
      );
    if (plan.analysisMetadata) {
      result.push(
        '',
        '### 生成参数',
        '',
        `市场：${plan.analysisMetadata.options.market}；语言：${plan.analysisMetadata.options.language}；平台：${plan.analysisMetadata.options.platform}；时长：${plan.analysisMetadata.options.duration}s`,
        '',
        '### 证据与边界',
      );
      for (const key of ['facts', 'merchantClaims', 'inferences', 'unknowns'] as const)
        result.push(
          '',
          `#### ${key}`,
          '',
          ...plan.analysisMetadata.evidence[key].map((item) => `- ${markdown(item)}`),
        );
    }
  }
  return result.join('\n');
}
export const comparisonFieldLabels: Record<ComparisonField, string> = {
  coreDifferences: '核心差异',
  verifiableSellingPoints: '可核实卖点比较',
  audienceDifferences: '目标用户差异（推断）',
  opportunities: '潜在营销机会（假设）',
  contentAngles: '差异化内容角度',
  videoRecommendations: '短视频营销建议',
  risks: '待确认信息与风险',
};
