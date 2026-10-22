import { randomUUID } from 'node:crypto';
import {
  contentGenerationSchema,
  estimateContentDuration,
  productAnalysisReference,
  type ContentGenerationResponse,
  type ContentMetadata,
  type AnalysisUsage,
  type GenerationTokenUsage,
  type AnalysisPricing,
} from '@productspy/shared';
import { withProductAnalysisLock } from '../../../lib/ai';
import { createAIProviderForExecution } from '../../../lib/ai/channels';
import {
  executionUsageMetadata,
  getAnalysisUsageLedger,
  requestFingerprint,
  resolveUsageExecution,
} from '../../../lib/server/analysis-usage';
import { contentGenerationInputSchema } from '../../../lib/saas/job-input';
import { getContentRepository } from '../../../lib/server/content-repository';
import { AppError } from '../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../lib/server/http';
import {
  applyContentSelection,
  contentCapturedEvidence,
  contentRequestData,
} from '../../../lib/ai/content-generation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function calculateUsage(
  mode: 'mock' | 'real',
  usage?: GenerationTokenUsage,
  pricing?: AnalysisPricing,
): AnalysisUsage {
  if (mode === 'mock') return { inputTokens: 0, outputTokens: 0, costUsd: 0, costEstimated: false };
  const input = usage?.inputTokens,
    output = usage?.outputTokens;
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
      const input = contentGenerationInputSchema.safeParse(await readJsonBody(request));
      if (!input.success) throw new AppError(400, '内容方案或生成参数无效，请刷新后重试。');
      const repository = getContentRepository(),
        ledger = getAnalysisUsageLedger();
      const requestId = input.data.requestId ?? randomUUID();
      return withProductAnalysisLock(`${repository.filePath}:${input.data.planId}`, async () => {
        const plan = await repository.get(input.data.planId);
        if (!plan) throw new AppError(404, '内容方案已删除或不存在。');
        const prior = await ledger.get(requestId);
        const execution = await resolveUsageExecution(prior, input.data);
        const { mode } = execution;
        const fingerprint = requestFingerprint({
          planId: input.data.planId,
          updatedAt: input.data.expectedUpdatedAt,
          options: input.data.options,
          selectedFields: input.data.selectedFields,
          pricing: input.data.pricing,
          mode,
          model: mode === 'real' ? execution.model : undefined,
          ...(!prior || prior.execution ? { execution } : {}),
        });
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new AppError(409, '请求编号已用于不同内容，请刷新后重新操作。');
          const version = plan.versions.find(
            (item) => item.kind === 'generated' && item.metadata?.requestId === requestId,
          );
          if (version?.metadata)
            return { plan, version, requestId, replayed: true } satisfies ContentGenerationResponse;
          throw new AppError(
            409,
            '该生成请求已经发起或中断，请检查已保存内容和用量。为避免重复费用，不会再次调用服务。',
          );
        }
        if (mode === 'real' && input.data.authorizeReal !== true)
          throw new AppError(
            428,
            '真实 AI 内容生成可能产生费用，请明确授权此次请求和预算；尚未调用服务。',
          );
        if (plan.updatedAt !== input.data.expectedUpdatedAt)
          throw new AppError(409, '内容方案已更新，请刷新；人工修改和历史未覆盖。');
        if (
          input.data.selectedFields?.some(
            (field) => !plan.templateSnapshot.outputFields.includes(field),
          )
        )
          throw new AppError(400, '重新生成项目必须是模板所选内容类型。');
        await repository.assertCapacity(plan.id, plan.updatedAt);
        // Validate expanded prompt before reserving usage or making a potentially paid request.
        contentRequestData(plan, input.data.options, input.data.selectedFields);
        const provider = await createAIProviderForExecution(execution);
        if (!provider.createContent)
          throw new AppError(503, '当前 AI Provider 不支持内容创作，请检查配置。');
        await ledger.begin({
          requestId,
          productId: `content:${plan.id}`,
          fingerprint,
          ...executionUsageMetadata(execution),
          execution,
          contentOptions: input.data.options,
          ...(input.data.selectedFields ? { contentFields: input.data.selectedFields } : {}),
        });
        let usage: AnalysisUsage | undefined;
        try {
          const generated = contentGenerationSchema.safeParse(
            await provider.createContent(plan, input.data.options, input.data.selectedFields),
          );
          if (!generated.success)
            throw new AppError(502, 'AI 内容结构、脚本或事实边界无效；未保存，没有自动重试。');
          usage = calculateUsage(mode, generated.data.usage, input.data.pricing);
          const output = applyContentSelection(
            generated.data.output,
            input.data.selectedFields ?? plan.templateSnapshot.outputFields,
            input.data.options.language,
          );
          const evidence = contentCapturedEvidence(plan, input.data.options, output);
          evidence.inferences = [
            ...new Set([...evidence.inferences, ...generated.data.evidence.inferences]),
          ].slice(0, 30);
          evidence.unknowns = [
            ...new Set([...evidence.unknowns, ...generated.data.evidence.unknowns]),
          ].slice(0, 30);
          const metadata: ContentMetadata = {
            ...executionUsageMetadata(execution),
            options: input.data.options,
            generatedAt: new Date().toISOString(),
            sourceUpdatedAt: plan.productSnapshot.updatedAt,
            selectedMedia: plan.selectedMedia ?? [],
            ...(productAnalysisReference(plan.productSnapshot)
              ? { productAnalysisReference: productAnalysisReference(plan.productSnapshot) }
              : {}),
            templateId: plan.templateSnapshot.id,
            templateVersionId: plan.templateSnapshot.versions.at(-1)?.id,
            evidence,
            usage,
            requestId,
            ...(input.data.selectedFields ? { selectedFields: input.data.selectedFields } : {}),
            textDurationEstimate: estimateContentDuration(output, input.data.options),
          };
          const saved = await repository.saveGenerated(
            plan.id,
            output,
            plan.updatedAt,
            metadata,
            input.data.selectedFields,
          );
          await ledger
            .finish(requestId, { versionId: saved.version.id, usage })
            .catch((error: unknown) =>
              console.error(
                '[ProductSpy content AI] Result saved but usage completion unknown',
                error,
              ),
            );
          return { ...saved, requestId, replayed: false } satisfies ContentGenerationResponse;
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
                '[ProductSpy content AI] Unable to finish reserved usage; no automatic retry',
                ledgerError,
              ),
            );
          throw error;
        }
      });
    },
    { write: true, webOnly: true },
  );
}
export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['POST'], { webOnly: true });
}
