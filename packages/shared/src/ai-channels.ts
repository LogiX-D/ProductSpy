import { z } from 'zod';

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const noControlCharacters = (value: string) =>
  Array.from(value).every(
    (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
  );
const modelId = z.string().trim().min(1).max(200).refine(noControlCharacters, '不能包含控制字符');
export const aiSelectionSchema = z
  .object({ channelId: identifier.optional(), model: modelId.optional() })
  .strict();
export type AISelection = z.infer<typeof aiSelectionSchema>;

export const aiProviderIds = [
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'dashscope',
  'volcengine',
  'moonshot',
  'zhipu',
  'qianfan',
  'hunyuan',
  'minimax',
  'siliconflow',
  'openrouter',
  'custom',
] as const;
export const aiProviderIdSchema = z.enum(aiProviderIds);
export type AIProviderId = z.infer<typeof aiProviderIdSchema>;
export type AIProtocol = 'openai-compatible' | 'anthropic';
export const aiChannelModelSchema = z
  .object({ id: modelId, label: z.string().trim().min(1).max(100) })
  .strict();
export type AIChannelModel = z.infer<typeof aiChannelModelSchema>;
export interface AIPublicChannel {
  id: string;
  label: string;
  provider: AIProviderId | 'mock';
  mode: 'mock' | 'real';
  models: AIChannelModel[];
  defaultModel: string;
}
export interface AIChannelCatalog {
  defaultChannelId: string;
  channels: AIPublicChannel[];
  canManage: boolean;
}
export interface AIProviderPreset {
  id: AIProviderId;
  label: string;
  protocol: AIProtocol;
  baseUrl: string;
  documentationUrl: string;
}
export const aiChannelInputSchema = z
  .object({
    id: identifier.refine(
      (value) => value !== 'mock' && value !== 'legacy',
      '该渠道 ID 为系统保留',
    ),
    label: z.string().trim().min(1).max(80),
    provider: aiProviderIdSchema,
    baseUrl: z.string().trim().min(1).max(2048),
    models: z.array(aiChannelModelSchema).min(1).max(30),
    defaultModel: modelId,
    enabled: z.boolean(),
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .refine(noControlCharacters, '不能包含控制字符')
      .optional(),
    responseFormat: z.enum(['json_object', 'json_schema', 'text']).default('json_object'),
    tokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
    timeoutMs: z.number().int().min(1).max(120000).default(60000),
    maxOutputTokens: z.number().int().min(256).max(32768).default(8192),
    temperature: z.number().min(0).max(2).optional(),
    thinking: z.enum(['disabled', 'enabled']).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.models.map((model) => model.id);
    if (new Set(ids).size !== ids.length || !ids.includes(value.defaultModel))
      ctx.addIssue({ code: 'custom', message: '模型不能重复，默认模型必须位于该渠道的模型列表中' });
  });
export type AIChannelInput = z.infer<typeof aiChannelInputSchema>;
export type AIAdminChannel = Omit<AIChannelInput, 'apiKey'> & { apiKeyConfigured: boolean };
export const aiChannelSettingsInputSchema = z
  .object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    defaultChannelId: identifier,
    channels: z.array(aiChannelInputSchema).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.channels.map((channel) => channel.id)).size !== value.channels.length)
      ctx.addIssue({ code: 'custom', message: '渠道 ID 不能重复' });
    if (
      value.defaultChannelId !== 'mock' &&
      !value.channels.some((channel) => channel.enabled && channel.id === value.defaultChannelId)
    )
      ctx.addIssue({ code: 'custom', message: '默认渠道必须已启用，或使用 Mock 演示' });
  });
export interface AIAdminChannelSettings {
  revision: number;
  defaultChannelId: string;
  channels: AIAdminChannel[];
  presets: AIProviderPreset[];
  editable: boolean;
  storage: 'database' | 'environment';
  realCallsEnabled: boolean;
}
