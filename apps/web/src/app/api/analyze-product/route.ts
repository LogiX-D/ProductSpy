import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ANALYSIS_FIELDS,
  DEFAULT_ANALYSIS_OPTIONS,
  analysisFieldSchema,
  analysisOptionsSchema,
  analysisPricingSchema,
  analysisSchema,
  generationResultSchema,
  productSchema,
  type AnalysisGenerationResponse,
  type AnalysisMetadata,
  type AnalysisPricing,
  type AnalysisUsage,
  type GenerationTokenUsage,
  type ProductAnalysis,
} from '@productspy/shared';
import { createAIProvider, withProductAnalysisLock } from '../../../lib/ai';
import { getAnalysisUsageLedger, requestFingerprint } from '../../../lib/server/analysis-usage';
import { AppError } from '../../../lib/server/errors';
import {
  assertLocalRequest,
  preflight,
  readJsonBody,
  withApiRequest,
} from '../../../lib/server/http';
import { getProductRepository } from '../../../lib/server/product-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const envelopeSchema = z.object({
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
});

function calculateUsage(
  mode: 'mock' | 'real',
  usage?: GenerationTokenUsage,
  pricing?: AnalysisPricing,
): AnalysisUsage {
  if (mode === 'mock') return { inputTokens: 0, outputTokens: 0, costUsd: 0, costEstimated: false };
  const complete = usage?.inputTokens !== undefined && usage.outputTokens !== undefined;
  return {
    ...usage,
    costEstimated: Boolean(pricing && complete),
    ...(pricing ? { pricing } : {}),
    ...(pricing && complete
      ? {
          costUsd:
            (usage.inputTokens! * pricing.inputUsdPerMillion +
              usage.outputTokens! * pricing.outputUsdPerMillion) /
            1000000,
        }
      : {}),
  };
}

export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const raw = await readJsonBody(request);
      const modern = Boolean(raw && typeof raw === 'object' && 'product' in raw);
      const parsed = envelopeSchema.safeParse(modern ? raw : { product: raw });
      if (!parsed.success)
        throw new AppError(400, '商品数据或分析参数格式无效，请刷新商品并检查参数后重试');
      const input = parsed.data;
      const mode =
        process.env.AI_MODE === 'mock' ||
        (!process.env.AI_API_KEY?.trim() && process.env.AI_MODE !== 'real')
          ? 'mock'
          : 'real';
      if (mode === 'real') await assertLocalRequest(request, true, { webOnly: true });
      if (mode === 'real' && input.authorizeReal !== true)
        throw new AppError(
          428,
          '真实 AI 可能产生费用。请在工作台确认此次请求与用量预算后再生成；尚未调用 AI 服务。',
        );

      const repository = getProductRepository();
      const ledger = getAnalysisUsageLedger();
      const requestId = input.requestId ?? randomUUID();
      const fields = input.fields ? [...input.fields].sort() : undefined;
      const fingerprint = requestFingerprint({
        productId: input.product.id,
        updatedAt: input.product.updatedAt,
        options: input.options,
        fields,
        pricing: input.pricing,
        mode,
        model: mode === 'real' ? process.env.AI_MODEL || 'gpt-4o-mini' : undefined,
      });
      return withProductAnalysisLock(`${repository.filePath}:${input.product.id}`, async () => {
        const product = await repository.get(input.product.id);
        if (!product) throw new AppError(404, '商品已删除或不存在，请返回商品库刷新');
        const prior = await ledger.get(requestId);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new AppError(409, '此请求编号已用于不同的分析内容，请刷新后重新操作。');
          const version = product.analysisHistory?.find(
            (item) => item.metadata?.requestId === requestId,
          );
          if (version?.metadata) {
            const response: AnalysisGenerationResponse = {
              product,
              analysis: version.analysis,
              metadata: version.metadata,
              requestId,
              replayed: true,
            };
            return modern ? response : response.analysis;
          }
          throw new AppError(
            409,
            '此分析请求已经发起或中断。请刷新查看结果；为避免重复扣费，不会自动再次请求。',
          );
        }
        if (product.updatedAt !== input.product.updatedAt)
          throw new AppError(409, '商品资料已更新，请刷新商品后重新分析');
        if (fields && !product.aiAnalysis)
          throw new AppError(400, '请先生成完整分析，再重新生成指定内容。');
        await repository.assertAnalysisCapacity(product.id, product.updatedAt);
        const provider = createAIProvider();
        await ledger.begin({
          requestId,
          productId: product.id,
          fingerprint,
          mode,
          options: input.options,
          fields,
          ...(mode === 'real' ? { model: process.env.AI_MODEL || 'gpt-4o-mini' } : {}),
        });
        let usage: AnalysisUsage | undefined;
        try {
          const result = provider.generate
            ? await provider.generate(product, input.options)
            : {
                analysis: await provider.analyze(product, input.options),
                evidence: {
                  facts: [],
                  inferences: [],
                  unknowns: ['旧 Provider 未返回逐项证据；请以商品页面核对分析内容。'],
                  reviewTextAnalyzed: false as const,
                },
              };
          const generated = generationResultSchema.safeParse(result);
          if (!generated.success)
            throw new AppError(502, 'AI 分析字段或事实依据不完整，请检查服务配置后重试');
          usage = calculateUsage(mode, generated.data.usage, input.pricing);
          let analysis: ProductAnalysis = generated.data.analysis;
          if (fields && product.aiAnalysis) {
            const merged = { ...product.aiAnalysis };
            for (const field of ANALYSIS_FIELDS) {
              if (!fields.includes(field)) continue;
              if (field === 'summary' || field === 'shortVideoScript')
                merged[field] = analysis[field];
              else merged[field] = analysis[field];
            }
            analysis = analysisSchema.parse(merged);
          }
          const metadata: AnalysisMetadata = {
            mode,
            ...(mode === 'real' ? { model: process.env.AI_MODEL || 'gpt-4o-mini' } : {}),
            options: input.options,
            generatedAt: new Date().toISOString(),
            sourceUpdatedAt: product.updatedAt,
            evidence: generated.data.evidence,
            usage,
            requestId,
            ...(fields ? { selectedFields: fields } : {}),
          };
          const saved = await repository.saveAnalysis(product.id, analysis, product.updatedAt, {
            kind: 'generated',
            metadata,
            selectedFields: fields,
          });
          await ledger
            .finish(requestId, { versionId: saved.analysisHistory?.at(-1)?.id, usage })
            .catch((ledgerError: unknown) => {
              // The result is already safe on disk. Keep the original reservation visible as
              // unknown rather than discarding content or issuing a second paid request.
              console.error(
                '[ProductSpy AI] Analysis saved; usage completion remains unknown',
                ledgerError,
              );
            });
          const response: AnalysisGenerationResponse = {
            product: saved,
            analysis,
            metadata,
            requestId,
            replayed: false,
          };
          return modern ? response : response.analysis;
        } catch (error) {
          const status = error instanceof AppError ? error.status : 500;
          const retryAfter =
            error &&
            typeof error === 'object' &&
            'retryAfterSeconds' in error &&
            typeof error.retryAfterSeconds === 'number'
              ? error.retryAfterSeconds
              : undefined;
          await ledger
            .finish(requestId, { usage, errorCode: status, retryAfterSeconds: retryAfter })
            .catch((ledgerError: unknown) => {
              console.error(
                '[ProductSpy AI] Unable to complete usage record; existing reservation prevents automatic retry',
                ledgerError,
              );
            });
          throw error;
        }
      });
    },
    { write: true },
  );
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['POST']);
}
