import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  analysisOptionsSchema,
  analysisPricingSchema,
  comparisonGenerationSchema,
  type AnalysisPricing,
  type AnalysisUsage,
  type ComparisonAnalysisMetadata,
  type ComparisonGenerationResponse,
  type GenerationTokenUsage,
} from '@productspy/shared';
import { createAIProvider, withProductAnalysisLock } from '../../../lib/ai';
import { getAnalysisUsageLedger, requestFingerprint } from '../../../lib/server/analysis-usage';
import { getComparisonRepository } from '../../../lib/server/comparison-repository';
import { AppError } from '../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../lib/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const envelopeSchema = z
  .object({
    comparisonId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    options: analysisOptionsSchema.default(DEFAULT_ANALYSIS_OPTIONS),
    pricing: analysisPricingSchema.optional(),
    requestId: z.string().uuid().optional(),
    authorizeReal: z.boolean().optional(),
  })
  .strict();
function calculateUsage(
  mode: 'mock' | 'real',
  usage?: GenerationTokenUsage,
  pricing?: AnalysisPricing,
): AnalysisUsage {
  if (mode === 'mock') return { inputTokens: 0, outputTokens: 0, costUsd: 0, costEstimated: false };
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  return {
    ...usage,
    costEstimated: Boolean(pricing && input !== undefined && output !== undefined),
    ...(pricing ? { pricing } : {}),
    ...(pricing && input !== undefined && output !== undefined
      ? {
          costUsd:
            (input * pricing.inputUsdPerMillion + output * pricing.outputUsdPerMillion) / 1000000,
        }
      : {}),
  };
}
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const input = envelopeSchema.safeParse(await readJsonBody(request));
      if (!input.success) throw new AppError(400, '对比方案或分析参数格式无效，请刷新后重试');
      const mode =
        process.env.AI_MODE === 'mock' ||
        (!process.env.AI_API_KEY?.trim() && process.env.AI_MODE !== 'real')
          ? 'mock'
          : 'real';
      if (mode === 'real' && input.data.authorizeReal !== true)
        throw new AppError(
          428,
          '真实 AI 对比可能产生费用。请明确确认此次请求及预算；尚未调用服务。',
        );
      const repository = getComparisonRepository();
      const ledger = getAnalysisUsageLedger();
      const requestId = input.data.requestId ?? randomUUID();
      const model = mode === 'real' ? process.env.AI_MODEL || 'gpt-4o-mini' : undefined;
      const fingerprint = requestFingerprint({
        comparisonId: input.data.comparisonId,
        updatedAt: input.data.expectedUpdatedAt,
        options: input.data.options,
        pricing: input.data.pricing,
        mode,
        model,
      });
      return withProductAnalysisLock(
        `${repository.filePath}:${input.data.comparisonId}`,
        async () => {
          const plan = await repository.get(input.data.comparisonId);
          if (!plan) throw new AppError(404, '对比方案已删除或不存在');
          const prior = await ledger.get(requestId);
          if (prior) {
            if (prior.fingerprint !== fingerprint)
              throw new AppError(409, '请求编号已用于不同内容，请刷新后重新操作。');
            const version = plan.analysisHistory?.find(
              (item) => item.metadata?.requestId === requestId,
            );
            if (version?.metadata) {
              const response: ComparisonGenerationResponse = {
                plan,
                analysis: version.analysis,
                metadata: version.metadata,
                requestId,
                replayed: true,
              };
              return response;
            }
            throw new AppError(
              409,
              '该请求已经发起或中断，请检查已保存结果与用量。为避免重复费用，不会重新调用服务。',
            );
          }
          if (plan.updatedAt !== input.data.expectedUpdatedAt)
            throw new AppError(409, '对比方案已更新，请刷新后重新分析。');
          await repository.assertAnalysisCapacity(plan.id, plan.updatedAt);
          const provider = createAIProvider();
          if (!provider.compare)
            throw new AppError(503, '当前 AI Provider 暂不支持对比分析，请检查配置。');
          await ledger.begin({
            requestId,
            productId: `comparison:${plan.id}`,
            fingerprint,
            mode,
            options: input.data.options,
            ...(model ? { model } : {}),
          });
          let usage: AnalysisUsage | undefined;
          try {
            const generated = comparisonGenerationSchema.safeParse(
              await provider.compare(plan.products, input.data.options),
            );
            if (!generated.success)
              throw new AppError(502, '对比分析结构或事实边界不完整；没有保存，也没有自动重试。');
            usage = calculateUsage(mode, generated.data.usage, input.data.pricing);
            const metadata: ComparisonAnalysisMetadata = {
              mode,
              ...(model ? { model } : {}),
              options: input.data.options,
              generatedAt: new Date().toISOString(),
              sourceUpdatedAt: plan.snapshotUpdatedAt ?? plan.createdAt,
              evidence: generated.data.evidence,
              usage,
              requestId,
            };
            const saved = await repository.saveAnalysis(
              plan.id,
              generated.data.analysis,
              plan.updatedAt,
              { kind: 'generated', metadata },
            );
            await ledger
              .finish(requestId, { versionId: saved.analysisHistory?.at(-1)?.id, usage })
              .catch((error: unknown) =>
                console.error(
                  '[ProductSpy comparison AI] Result saved but usage completion unknown',
                  error,
                ),
              );
            const response: ComparisonGenerationResponse = {
              plan: saved,
              analysis: generated.data.analysis,
              metadata,
              requestId,
              replayed: false,
            };
            return response;
          } catch (error) {
            const status = error instanceof AppError ? error.status : 500;
            const retryAfterSeconds =
              error &&
              typeof error === 'object' &&
              'retryAfterSeconds' in error &&
              typeof error.retryAfterSeconds === 'number'
                ? error.retryAfterSeconds
                : undefined;
            await ledger
              .finish(requestId, { usage, errorCode: status, retryAfterSeconds })
              .catch((ledgerError: unknown) =>
                console.error(
                  '[ProductSpy comparison AI] Unable to finish reserved usage; no automatic retry',
                  ledgerError,
                ),
              );
            throw error;
          }
        },
      );
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['POST'], { webOnly: true });
}
