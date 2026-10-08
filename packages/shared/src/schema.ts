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
});
export const productSchema = draftSchema.extend({
  id: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  aiAnalysis: analysisSchema.optional(),
});
