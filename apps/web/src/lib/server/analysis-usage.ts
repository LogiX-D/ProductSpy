import { publishAtomicFile } from './atomic-file';
import { withBusinessOperation } from './business-lock';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  type AnalysisUsage,
  type AnalysisUsageReport,
  analysisUsageRecordSchema,
  type AISelection,
} from '@productspy/shared';
import { currentAIExecution, resolveAIExecution, type ResolvedAIExecution } from '../ai/channels';
import { resolvedAIExecutionSchema } from '../saas/job-input';
import { AppError } from './errors';
import { dataDirectory } from './product-repository';
import { saasEnabled } from '../saas/context';
import { dbTransaction } from '../saas/database';
import { consumeAIAllowance } from '../saas/entitlements';
import { startAIJob, finishAIJob } from '../saas/jobs';
import { readWorkspaceDocument, writeWorkspaceDocument } from '../saas/workspace-storage';

const usageRecordSchema = analysisUsageRecordSchema
  .extend({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    versionId: z.string().min(1).max(100).optional(),
    errorCode: z.number().int().optional(),
    cooldownUntil: z.string().datetime().optional(),
    execution: resolvedAIExecutionSchema.optional(),
  })
  .strict()
  .refine(
    (record) => Boolean(record.options) !== Boolean(record.contentOptions),
    '用量记录必须具有唯一且准确的生成参数',
  );
export type UsageRecord = z.infer<typeof usageRecordSchema>;

/** Server-only ledger parser, including the immutable execution decision. */
export function parseStoredAnalysisUsage(value: unknown): UsageRecord[] {
  const records = usageRecordSchema.array().parse(value);
  if (new Set(records.map((record) => record.requestId)).size !== records.length)
    throw new Error('Duplicate request identifiers');
  return records;
}

interface UsageRegistry {
  queues: Map<string, Promise<unknown>>;
  active: Map<string, Set<string>>;
  ledgers: Map<string, AnalysisUsageLedger>;
}
const globalRegistry = globalThis as typeof globalThis & { __productspyUsage?: UsageRegistry };
const registry = (globalRegistry.__productspyUsage ??= {
  queues: new Map(),
  active: new Map(),
  ledgers: new Map(),
});

export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Replays stay bound to the original decision even after an administrator changes defaults. */
export async function resolveUsageExecution(
  prior: UsageRecord | undefined,
  selection: AISelection,
): Promise<ResolvedAIExecution> {
  const execution = prior?.execution;
  if (!execution)
    return resolveAIExecution({ channelId: selection.channelId, model: selection.model });
  if (
    (selection.channelId !== undefined && selection.channelId !== execution.channelId) ||
    (selection.model !== undefined && selection.model !== execution.model)
  )
    throw new AppError(409, '此请求编号已用于不同 AI 渠道或模型，请重新确认并使用新的请求编号。');
  const taskExecution = currentAIExecution();
  if (taskExecution && requestFingerprint(taskExecution) !== requestFingerprint(execution))
    throw new AppError(409, '任务执行渠道与原请求不一致；不会重新调用 AI。');
  return execution;
}

export function executionUsageMetadata(execution: ResolvedAIExecution) {
  return {
    mode: execution.mode,
    ...(execution.mode === 'real' ? { model: execution.model } : {}),
    channelId: execution.channelId,
    channelLabel: execution.channelLabel,
    provider: execution.provider,
  };
}

export function dailyRealLimit(): number {
  const configured = Number(process.env.AI_DAILY_REQUEST_LIMIT ?? 50);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 10000
    ? configured
    : 50;
}

export class AnalysisUsageLedger {
  readonly directory: string;
  readonly filePath: string;
  private readonly active: Set<string>;

  constructor(directory = dataDirectory()) {
    this.directory = resolve(/* turbopackIgnore: true */ directory);
    this.filePath = join(this.directory, 'analysis-usage.json');
    let active = registry.active.get(this.filePath);
    if (!active) {
      active = new Set();
      registry.active.set(this.filePath, active);
    }
    this.active = active;
  }

  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const prior = registry.queues.get(this.filePath) ?? Promise.resolve();
    const result = prior
      .catch(() => undefined)
      .then(() =>
        withBusinessOperation(this.directory, () =>
          saasEnabled() ? dbTransaction(operation) : operation(),
        ),
      );
    registry.queues.set(
      this.filePath,
      result.catch(() => undefined),
    );
    return result;
  }

  private async read(): Promise<UsageRecord[]> {
    try {
      const source = saasEnabled()
        ? await readWorkspaceDocument(this.directory, 'analysis-usage.json')
        : await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(source);
      return parseStoredAnalysisUsage(parsed);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return [];
      throw new AppError(
        500,
        '本地 AI 用量记录无法读取。为避免意外消耗，尚未发起新的 AI 请求。请保留 analysis-usage.json 并检查日志。',
      );
    }
  }

  private async write(records: UsageRecord[]): Promise<void> {
    if (saasEnabled()) {
      await writeWorkspaceDocument(this.directory, 'analysis-usage.json', JSON.stringify(records));
      return;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.analysis-usage-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(records, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await publishAtomicFile(temporary, this.filePath);
    } catch {
      throw new AppError(
        500,
        '本地 AI 用量记录无法保存。请检查用户数据目录空间与权限；不会自动重试 AI 请求。',
      );
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  get(requestId: string): Promise<UsageRecord | undefined> {
    return this.transaction(async () =>
      (await this.read()).find((item) => item.requestId === requestId),
    );
  }

  begin(
    input: Pick<
      UsageRecord,
      | 'requestId'
      | 'productId'
      | 'fingerprint'
      | 'mode'
      | 'model'
      | 'channelId'
      | 'channelLabel'
      | 'provider'
      | 'execution'
      | 'options'
      | 'fields'
      | 'contentOptions'
      | 'contentFields'
    >,
  ): Promise<void> {
    return this.transaction(async () => {
      const records = await this.read();
      const existing = records.find((record) => record.requestId === input.requestId);
      if (existing)
        throw new AppError(
          409,
          existing.fingerprint !== input.fingerprint
            ? '此请求编号已用于不同的分析内容，请刷新后重新操作。'
            : '此分析请求已经发起。请刷新查看结果；为避免重复扣费，不会自动再次请求。',
        );
      if (input.mode === 'real') {
        const cooldown = records.reduce(
          (latest, record) => Math.max(latest, Date.parse(record.cooldownUntil ?? '') || 0),
          0,
        );
        if (cooldown > Date.now()) {
          const seconds = Math.ceil((cooldown - Date.now()) / 1000);
          throw new AppError(
            429,
            `AI 服务正在限流，请等待约 ${seconds} 秒后重新确认。没有自动重试。`,
          );
        }
        if (this.active.size >= 2)
          throw new AppError(429, '已有 2 个真实 AI 请求进行中，请等待完成后再操作。');
        const today = new Date().toISOString().slice(0, 10);
        const used = records.filter(
          (record) => record.mode === 'real' && record.createdAt.startsWith(today),
        ).length;
        if (used >= dailyRealLimit())
          throw new AppError(
            429,
            `已达到今天 ${dailyRealLimit()} 次真实 AI 请求的本机保护上限。失败或中断请求也计入，避免未知费用被重复消耗。`,
          );
      }
      const record = usageRecordSchema.safeParse({
        ...input,
        id: randomUUID(),
        ...(input.options ? { options: { ...input.options, customInstructions: '' } } : {}),
        ...(input.contentOptions
          ? {
              contentOptions: {
                ...input.contentOptions,
                customInstructions: '',
                customPrompt: '',
                creativeDirection: '',
              },
            }
          : {}),
        status: 'started',
        createdAt: new Date().toISOString(),
      });
      if (!record.success || Boolean(input.options) === Boolean(input.contentOptions))
        throw new AppError(
          503,
          'AI 请求配置或用量记录格式无效，请检查模型名称与参数；尚未调用 AI 服务。',
        );
      records.push(record.data);
      if (saasEnabled()) {
        await consumeAIAllowance(input.requestId);
        await startAIJob(
          input.requestId,
          input.productId.startsWith('content:')
            ? 'content'
            : input.productId.startsWith('comparison:')
              ? 'comparison'
              : 'analysis',
        );
      }
      // Commit the reservation before any network operation. A crash remains visible as unknown.
      await this.write(records);
      if (input.mode === 'real') this.active.add(input.requestId);
    });
  }

  finish(
    requestId: string,
    result: {
      versionId?: string;
      usage?: AnalysisUsage;
      errorCode?: number;
      retryAfterSeconds?: number;
    },
  ): Promise<void> {
    return this.transaction(async () => {
      const records = await this.read();
      const record = records.find((item) => item.requestId === requestId);
      if (!record) throw new AppError(500, 'AI 用量记录缺少已发起请求；不会重复调用服务。');
      record.status =
        result.errorCode === 409 ? 'conflict' : result.errorCode ? 'failed' : 'succeeded';
      record.completedAt = new Date().toISOString();
      if (result.versionId) record.versionId = result.versionId;
      if (result.usage) record.usage = result.usage;
      if (result.errorCode) record.errorCode = result.errorCode;
      if (result.errorCode === 429) {
        const retryAfter = result.retryAfterSeconds;
        const seconds =
          typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(86400, Math.max(1, Math.ceil(retryAfter)))
            : 60;
        record.cooldownUntil = new Date(Date.now() + seconds * 1000).toISOString();
      }
      await this.write(records);
      if (saasEnabled())
        await finishAIJob(
          requestId,
          record.status === 'succeeded' ? 'succeeded' : 'failed',
          result.errorCode,
        );
    }).finally(() => this.active.delete(requestId));
  }

  report(): Promise<AnalysisUsageReport> {
    return this.transaction(async () => {
      const records = await this.read();
      const real = records.filter((record) => record.mode === 'real');
      const cooldown = records.reduce(
        (latest, record) => Math.max(latest, Date.parse(record.cooldownUntil ?? '') || 0),
        0,
      );
      return {
        // The fingerprint is an internal binding, not useful in the product UI.
        records: [...records].reverse().map((record) => analysisUsageRecordSchema.parse(record)),
        totals: {
          requests: records.length,
          realRequests: real.length,
          inputTokens: records.reduce((sum, record) => sum + (record.usage?.inputTokens ?? 0), 0),
          outputTokens: records.reduce((sum, record) => sum + (record.usage?.outputTokens ?? 0), 0),
          costUsd: records.reduce((sum, record) => sum + (record.usage?.costUsd ?? 0), 0),
          unknownTokenRequests: real.filter(
            (record) =>
              record.usage?.inputTokens === undefined || record.usage?.outputTokens === undefined,
          ).length,
          unknownCostRequests: real.filter((record) => record.usage?.costUsd === undefined).length,
        },
        limits: {
          dailyLimit: dailyRealLimit(),
          dailyRealRequests: real.filter((record) =>
            record.createdAt.startsWith(new Date().toISOString().slice(0, 10)),
          ).length,
          maxConcurrent: 2,
          ...(cooldown > Date.now() ? { cooldownUntil: new Date(cooldown).toISOString() } : {}),
        },
      };
    });
  }
}

export function getAnalysisUsageLedger(): AnalysisUsageLedger {
  const directory = dataDirectory();
  let ledger = registry.ledgers.get(directory);
  if (!ledger) {
    ledger = new AnalysisUsageLedger(directory);
    registry.ledgers.set(directory, ledger);
  }
  return ledger;
}
