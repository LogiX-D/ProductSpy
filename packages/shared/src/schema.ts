import { z } from 'zod';

export const httpUrlSchema = z
  .string()
  .url()
  .max(4096)
  .refine((value) => /^https?:\/\//i.test(value), '需要 HTTP(S) URL');
const text = z.string().trim().min(1).max(12000);
const items = z.array(text).min(1).max(30);
export const analysisSchema = z.object({
  summary: text,
  sellingPoints: items,
  targetAudience: items,
  purchaseMotivations: items,
  painPoints: items,
  strengths: items,
  weaknesses: items,
  marketingAngles: items,
  hooks: z.array(text).min(5).max(30),
  shortVideoScript: text.refine(
    (value) =>
      ['Hook', 'Problem', 'Solution', 'Demo', 'CTA'].every((label) =>
        new RegExp(`(?:^|\\n)${label}\\s*[:：]`, 'i').test(value),
      ),
    '脚本需要 Hook / Problem / Solution / Demo / CTA 五段',
  ),
  imagePrompts: items,
  videoPrompts: items,
});

export const ANALYSIS_FIELDS = [
  'summary',
  'sellingPoints',
  'targetAudience',
  'purchaseMotivations',
  'painPoints',
  'strengths',
  'weaknesses',
  'marketingAngles',
  'hooks',
  'shortVideoScript',
  'imagePrompts',
  'videoPrompts',
] as const;
export const analysisFieldSchema = z.enum(ANALYSIS_FIELDS);
export const DEFAULT_ANALYSIS_OPTIONS = {
  market: 'US',
  language: 'zh-CN',
  platform: 'TikTok',
  style: 'casual',
  duration: 30,
  goal: 'consideration',
  customInstructions: '',
} as const;
export const analysisOptionsSchema = z.object({
  market: z.enum(['US', 'UK', 'EU', 'JP']).default('US'),
  language: z.enum(['zh-CN', 'en', 'ja']).default('zh-CN'),
  platform: z.enum(['TikTok', 'Reels', 'Shorts']).default('TikTok'),
  style: z.enum(['professional', 'casual', 'humorous', 'recommendation']).default('casual'),
  duration: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(30),
  goal: z.enum(['awareness', 'consideration', 'conversion']).default('consideration'),
  customInstructions: z.string().trim().max(4000).default(''),
});
/** Content duration is independent of the legacy product-analysis preference contract. */
export const contentOptionsSchema = analysisOptionsSchema
  .extend({
    duration: z.number().int().min(5).max(180).default(30),
    creativeDirection: z.string().trim().max(2000).default(''),
    customPrompt: z.string().trim().max(4000).default(''),
  })
  .strict();
export const analysisPricingSchema = z.object({
  inputUsdPerMillion: z.number().finite().min(0).max(10000),
  outputUsdPerMillion: z.number().finite().min(0).max(10000),
});
export const analysisEvidenceSchema = z.object({
  facts: z.array(text).max(30),
  inferences: z.array(text).max(30),
  unknowns: z.array(text).max(30),
  reviewTextAnalyzed: z.literal(false),
});
export const generationTokenUsageSchema = z.object({
  inputTokens: z.number().int().min(0).max(1000000000).optional(),
  outputTokens: z.number().int().min(0).max(1000000000).optional(),
});
export const generationResultSchema = z.object({
  analysis: analysisSchema,
  evidence: analysisEvidenceSchema,
  usage: generationTokenUsageSchema.optional(),
});
export const analysisUsageSchema = generationTokenUsageSchema.extend({
  costUsd: z.number().finite().min(0).optional(),
  costEstimated: z.boolean(),
  pricing: analysisPricingSchema.optional(),
});
export const analysisMetadataSchema = z.object({
  mode: z.enum(['mock', 'real', 'legacy']),
  model: z.string().max(200).optional(),
  channelId: z.string().min(1).max(64).optional(),
  channelLabel: z.string().min(1).max(80).optional(),
  provider: z.string().min(1).max(64).optional(),
  options: analysisOptionsSchema,
  generatedAt: z.string().datetime(),
  sourceUpdatedAt: z.string().datetime(),
  evidence: analysisEvidenceSchema,
  usage: analysisUsageSchema.optional(),
  requestId: z.string().uuid().optional(),
  selectedFields: z.array(analysisFieldSchema).min(1).max(12).optional(),
});
export const MAX_ANALYSIS_VERSIONS = 50;
export const analysisVersionSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  kind: z.enum(['legacy', 'generated', 'edited', 'restored']),
  analysis: analysisSchema,
  metadata: analysisMetadataSchema.optional(),
  parentVersionId: z.string().uuid().optional(),
  archivedParentVersionId: z.string().uuid().optional(),
  archivedParentSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  restoredFrom: z.string().uuid().optional(),
});
export const analysisUsageRecordSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  productId: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  mode: z.enum(['mock', 'real']),
  model: z.string().max(200).optional(),
  channelId: z.string().min(1).max(64).optional(),
  channelLabel: z.string().min(1).max(80).optional(),
  provider: z.string().min(1).max(64).optional(),
  status: z.enum(['started', 'succeeded', 'failed', 'conflict']),
  options: analysisOptionsSchema.optional(),
  contentOptions: contentOptionsSchema.optional(),
  contentFields: z
    .array(
      z.enum([
        'sellingCopy',
        'shortVideoScript',
        'hooks',
        'storyboard',
        'voiceover',
        'titlesDescriptions',
        'imagePrompts',
        'videoPrompts',
        'adAngles',
      ]),
    )
    .min(1)
    .max(9)
    .optional(),
  fields: z.array(analysisFieldSchema).min(1).max(12).optional(),
  usage: analysisUsageSchema.optional(),
  error: z.string().max(1000).optional(),
});

export const AMAZON_DOMAINS = [
  'amazon.com',
  'amazon.ca',
  'amazon.com.mx',
  'amazon.com.br',
  'amazon.co.uk',
  'amazon.de',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.nl',
  'amazon.se',
  'amazon.pl',
  'amazon.com.be',
  'amazon.ie',
  'amazon.co.jp',
  'amazon.in',
  'amazon.com.au',
  'amazon.sg',
  'amazon.ae',
  'amazon.sa',
  'amazon.com.tr',
  'amazon.eg',
  'amazon.co.za',
] as const;
export function isAmazonUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      /^https?:$/.test(url.protocol) &&
      AMAZON_DOMAINS.some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}
export function isAmazonProductUrl(value: string): boolean {
  if (!isAmazonUrl(value)) return false;
  return /\/(?:dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}(?:[/?]|$)/i.test(new URL(value).pathname);
}
export const draftSchema = z.object({
  source: z.literal('amazon'),
  sourceId: z.string().regex(/^[A-Z0-9]{10}$/),
  url: httpUrlSchema.refine(isAmazonProductUrl, '仅支持 Amazon 商品详情页 URL'),
  title: z.string().trim().min(1).max(2000),
  price: z.string().max(200).optional(),
  currency: z.string().max(12).optional(),
  brand: z.string().max(500).optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().min(0).optional(),
  mainImage: httpUrlSchema.optional(),
  images: z.array(httpUrlSchema).max(100),
  videos: z.array(z.object({ url: httpUrlSchema, thumbnail: httpUrlSchema.optional() })).max(30),
  bulletPoints: z.array(z.string().max(12000)).max(50),
  description: z.string().max(50000).optional(),
  specifications: z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          value: z.string().trim().min(1).max(2000),
          source: z.literal('page'),
        })
        .strict(),
    )
    .max(80)
    .optional(),
  mediaMetadata: z
    .array(
      z
        .object({
          url: httpUrlSchema,
          kind: z.enum(['image', 'video']),
          extractedAt: z.string().datetime(),
          sourceUrl: httpUrlSchema.refine(isAmazonProductUrl),
          productSourceId: z.string().regex(/^[A-Z0-9]{10}$/),
          width: z.number().int().min(1).max(30000).optional(),
          height: z.number().int().min(1).max(30000).optional(),
        })
        .strict(),
    )
    .max(400)
    .optional(),
});
export const productSchema = draftSchema.extend({
  id: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  aiAnalysis: analysisSchema.optional(),
  analysisMetadata: analysisMetadataSchema.optional(),
  analysisHistory: z.array(analysisVersionSchema).max(MAX_ANALYSIS_VERSIONS).optional(),
  groupIds: z.array(z.string().uuid()).max(50).optional(),
  tagIds: z.array(z.string().uuid()).max(50).optional(),
});
