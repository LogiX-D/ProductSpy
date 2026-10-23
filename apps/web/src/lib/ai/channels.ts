import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  aiSelectionSchema,
  aiProviderIdSchema,
  type AISelection,
  type AIChannelCatalog,
  type AIPublicChannel,
  type AIProvider,
} from '@productspy/shared';
import { AppError } from '../server/errors';
import { saasEnabled } from '../saas/context';
import { canManageAIChannels, loadAIChannelSettings, type StoredAIChannel } from './channel-store';
import { providerPreset } from './provider-presets';
import { createAIProvider, legacyAIConfig } from './index';
import { MockAIProvider } from './mock-provider';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './openai-compatible-provider';

export const resolvedAIExecutionSchema = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1).max(64),
    channelLabel: z.string().min(1).max(80),
    provider: z.union([aiProviderIdSchema, z.literal('mock')]),
    model: z.string().min(1).max(200),
    mode: z.enum(['mock', 'real']),
    configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ResolvedAIExecution = z.infer<typeof resolvedAIExecutionSchema>;
const globalChannels = globalThis as typeof globalThis & {
  __productspyAIExecution?: AsyncLocalStorage<ResolvedAIExecution>;
};
const executionScope = (globalChannels.__productspyAIExecution ??=
  new AsyncLocalStorage<ResolvedAIExecution>());
export function currentAIExecution(): ResolvedAIExecution | undefined {
  return executionScope.getStore();
}
export async function withAIExecution<T>(
  execution: ResolvedAIExecution,
  operation: () => Promise<T>,
): Promise<T> {
  return executionScope.run(resolvedAIExecutionSchema.parse(execution), operation);
}
const mock: AIPublicChannel = {
  id: 'mock',
  label: 'Mock 演示',
  provider: 'mock',
  mode: 'mock',
  defaultModel: 'mock-template',
  models: [{ id: 'mock-template', label: 'Mock 演示模板' }],
};
interface Registry {
  defaultChannelId: string;
  channels: AIPublicChannel[];
  configuration: Map<string, StoredAIChannel | OpenAICompatibleConfig>;
}
function publicChannel(channel: StoredAIChannel): AIPublicChannel {
  return {
    id: channel.id,
    label: channel.label,
    provider: channel.provider,
    mode: 'real',
    models: channel.models,
    defaultModel: channel.defaultModel,
  };
}
async function registry(): Promise<Registry> {
  // Explicit mock is a global kill switch. It never attempts real-provider validation.
  if (process.env.AI_MODE === 'mock')
    return { defaultChannelId: mock.id, channels: [mock], configuration: new Map() };
  const stored = saasEnabled() ? await loadAIChannelSettings() : null;
  if (stored) {
    const channels = stored.channels.filter((channel) => channel.enabled);
    if (channels.some((channel) => !channel.apiKey))
      throw new AppError(503, '已启用的 AI 渠道缺少服务端密钥');
    return {
      defaultChannelId: stored.defaultChannelId,
      channels: [mock, ...channels.map(publicChannel)],
      configuration: new Map(channels.map((channel) => [channel.id, channel])),
    };
  }
  const legacyProvider = createAIProvider();
  if (legacyProvider instanceof MockAIProvider)
    return { defaultChannelId: mock.id, channels: [mock], configuration: new Map() };
  const config = legacyAIConfig();
  const model = config.model?.trim() || 'gpt-4o-mini';
  return {
    defaultChannelId: 'legacy',
    channels: [
      mock,
      {
        id: 'legacy',
        label: '服务端默认渠道',
        provider: 'custom',
        mode: 'real',
        defaultModel: model,
        models: [{ id: model, label: model }],
      },
    ],
    configuration: new Map([['legacy', config]]),
  };
}
export async function getAIChannelCatalog(): Promise<AIChannelCatalog> {
  const catalog = await registry();
  if (!catalog.channels.some((channel) => channel.id === catalog.defaultChannelId))
    throw new AppError(503, '默认 AI 渠道当前不可用，请联系管理员');
  return {
    defaultChannelId: catalog.defaultChannelId,
    channels: catalog.channels,
    canManage: saasEnabled() ? canManageAIChannels() : false,
  };
}
function configurationFor(
  entry: AIPublicChannel,
  model: string,
  settings: StoredAIChannel | OpenAICompatibleConfig,
): OpenAICompatibleConfig {
  if (entry.id === 'legacy') return { ...(settings as OpenAICompatibleConfig), model };
  const channel = settings as StoredAIChannel;
  return {
    apiKey: channel.apiKey ?? '',
    baseUrl: channel.baseUrl,
    model,
    protocol: providerPreset(channel.provider).protocol,
    providerId: channel.provider,
    responseFormat: channel.responseFormat,
    tokenParameter: channel.tokenParameter,
    timeoutMs: channel.timeoutMs,
    maxOutputTokens: channel.maxOutputTokens,
    temperature: channel.temperature,
    thinking: channel.thinking,
  };
}
function fingerprint(
  channel: AIPublicChannel,
  model: string,
  config?: OpenAICompatibleConfig,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        channelId: channel.id,
        provider: channel.provider,
        model,
        mode: channel.mode,
        apiKey: config?.apiKey ?? '',
        baseUrl: config?.baseUrl ?? '',
        protocol: config?.protocol ?? 'openai-compatible',
        responseFormat: config?.responseFormat ?? 'json_object',
        tokenParameter: config?.tokenParameter ?? 'max_tokens',
        timeoutMs: config?.timeoutMs ?? 60000,
        maxOutputTokens: config?.maxOutputTokens ?? 8192,
        temperature: config?.temperature ?? null,
        thinking: config?.thinking ?? null,
      }),
    )
    .digest('hex');
}
function assertSelection(execution: ResolvedAIExecution, selection: AISelection): void {
  if (
    (selection.channelId !== undefined && selection.channelId !== execution.channelId) ||
    (selection.model !== undefined && selection.model !== execution.model)
  )
    throw new AppError(409, '该任务已绑定原 AI 渠道和模型，请检查原任务结果');
}
async function resolved(selection: AISelection): Promise<{
  execution: ResolvedAIExecution;
  config?: OpenAICompatibleConfig;
}> {
  const state = await registry();
  const entry = state.channels.find(
    (channel) => channel.id === (selection.channelId ?? state.defaultChannelId),
  );
  if (!entry) throw new AppError(503, '所选 AI 渠道已停用或不可用，请重新选择；没有自动切换渠道');
  const model = selection.model ?? entry.defaultModel;
  if (!entry.models.some((candidate) => candidate.id === model))
    throw new AppError(400, '该模型不在所选渠道的管理员许可列表内');
  const stored = state.configuration.get(entry.id);
  const config = stored ? configurationFor(entry, model, stored) : undefined;
  if (entry.mode === 'real') {
    if (!config) throw new AppError(503, 'AI 渠道服务端配置缺失');
    new OpenAICompatibleProvider(config);
  }
  return {
    execution: {
      version: 1,
      channelId: entry.id,
      channelLabel: entry.label,
      provider: entry.provider,
      model,
      mode: entry.mode,
      configurationFingerprint: fingerprint(entry, model, config),
    },
    config,
  };
}
export async function resolveAIExecution(raw: AISelection = {}): Promise<ResolvedAIExecution> {
  const selection = aiSelectionSchema.parse(raw);
  const inherited = currentAIExecution();
  if (inherited) {
    assertSelection(inherited, selection);
    return inherited;
  }
  return (await resolved(selection)).execution;
}
async function verified(
  execution: ResolvedAIExecution,
): Promise<OpenAICompatibleConfig | undefined> {
  const expected = resolvedAIExecutionSchema.parse(execution);
  const current = await resolved({ channelId: expected.channelId, model: expected.model });
  if (
    current.execution.configurationFingerprint !== expected.configurationFingerprint ||
    current.execution.mode !== expected.mode ||
    current.execution.provider !== expected.provider
  )
    throw new AppError(503, '排队期间 AI 渠道配置已变化；本任务停止，未重新调用或切换其他渠道');
  return current.config;
}
export async function verifyAIExecution(execution: ResolvedAIExecution): Promise<void> {
  await verified(execution);
}
export async function createAIProviderForExecution(
  execution: ResolvedAIExecution,
): Promise<AIProvider> {
  const config = await verified(execution);
  return execution.mode === 'mock' ? new MockAIProvider() : new OpenAICompatibleProvider(config!);
}
