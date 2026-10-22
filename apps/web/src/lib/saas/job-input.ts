import { z } from 'zod';
import {
  CONTENT_FIELDS,
  DEFAULT_ANALYSIS_OPTIONS,
  DEFAULT_CONTENT_OPTIONS,
  aiSelectionSchema,
  aiProviderIds,
  analysisFieldSchema,
  analysisOptionsSchema,
  analysisPricingSchema,
  contentOptionsSchema,
  productSchema,
} from '@productspy/shared';
import type { ResolvedAIExecution } from '../ai/channels';

/** Internal persisted server decision. Never accept this field in an HTTP envelope. */
export const resolvedAIExecutionSchema: z.ZodType<ResolvedAIExecution> = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1).max(64),
    channelLabel: z.string().min(1).max(80),
    provider: z.enum([...aiProviderIds, 'mock']),
    model: z.string().min(1).max(200),
    mode: z.enum(['mock', 'real']),
    configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

// Queue acceptance and execution use the same strict envelopes. The client chooses only
// a channel/model from the server catalog, never provider credentials or an execution snapshot.
export const productAnalysisInputSchema = aiSelectionSchema
  .extend({
    product: productSchema,
    options: analysisOptionsSchema.default(DEFAULT_ANALYSIS_OPTIONS),
    fields: z
      .array(analysisFieldSchema)
      .min(1)
      .max(12)
      .refine((fields) => new Set(fields).size === fields.length)
      .optional(),
    pricing: analysisPricingSchema.optional(),
    requestId: z.string().uuid().optional(),
    authorizeReal: z.boolean().optional(),
  })
  .strict();

export const comparisonAnalysisInputSchema = aiSelectionSchema
  .extend({
    comparisonId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    options: analysisOptionsSchema.default(DEFAULT_ANALYSIS_OPTIONS),
    pricing: analysisPricingSchema.optional(),
    requestId: z.string().uuid().optional(),
    authorizeReal: z.boolean().optional(),
  })
  .strict();

export const contentGenerationInputSchema = aiSelectionSchema
  .extend({
    planId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    options: contentOptionsSchema.default(DEFAULT_CONTENT_OPTIONS),
    selectedFields: z
      .array(z.enum(CONTENT_FIELDS))
      .min(1)
      .max(9)
      .refine((fields) => new Set(fields).size === fields.length)
      .optional(),
    requestId: z.string().uuid().optional(),
    authorizeReal: z.boolean().optional(),
    pricing: analysisPricingSchema.optional(),
  })
  .strict();

export const aiJobEndpoints = [
  '/api/analyze-product',
  '/api/analyze-comparison',
  '/api/generate-content',
] as const;
export type AIJobEndpoint = (typeof aiJobEndpoints)[number];

export function parseAIJobInput(endpoint: AIJobEndpoint, input: unknown) {
  const schema =
    endpoint === '/api/analyze-product'
      ? productAnalysisInputSchema
      : endpoint === '/api/analyze-comparison'
        ? comparisonAnalysisInputSchema
        : contentGenerationInputSchema;
  return schema.safeParse(input);
}
