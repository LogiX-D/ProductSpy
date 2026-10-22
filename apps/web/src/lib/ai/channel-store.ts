import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  aiChannelSettingsInputSchema,
  type AIAdminChannelSettings,
  type AIChannelInput,
} from '@productspy/shared';
import { dbTransaction, query } from '../saas/database';
import { currentUserId, saasEnabled } from '../saas/context';
import { AppError } from '../server/errors';
import { AI_PROVIDER_PRESETS, providerPreset } from './provider-presets';
import { OpenAICompatibleProvider } from './openai-compatible-provider';

export type StoredAIChannel = AIChannelInput;
export interface StoredAIChannelSettings {
  revision: number;
  defaultChannelId: string;
  channels: StoredAIChannel[];
}
const AAD = Buffer.from('productspy:ai-channel-settings:v1');

export function canManageAIChannels(userId?: string): boolean {
  const raw = process.env.PRODUCTSPY_AI_ADMIN_IDS?.trim();
  if (!saasEnabled() || !raw) return false;
  const ids = raw.split(',').map((id) => id.trim());
  if (
    ids.length > 20 ||
    ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  )
    throw new AppError(503, 'AI 管理员账号 ID 配置无效，请联系运维');
  return ids.includes(userId ?? currentUserId());
}
function assertAdmin(): void {
  if (!canManageAIChannels()) throw new AppError(403, '仅指定的平台管理员可配置 AI 渠道');
}
function encryptionKey(): Buffer {
  const secret = process.env.PRODUCTSPY_AI_CHANNEL_SECRET;
  if (!secret || secret.trim().length < 32 || secret.length > 1024)
    throw new AppError(503, '请先在服务器配置独立的 AI 渠道加密主密钥');
  return createHash('sha256').update(AAD).update('\0').update(secret).digest();
}
function encrypt(settings: Omit<StoredAIChannelSettings, 'revision'>): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(settings), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    nonce.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    encrypted.toString('base64'),
  ].join(':');
}
function decrypt(ciphertext: string, revision: number): StoredAIChannelSettings {
  try {
    const parts = ciphertext.split(':');
    if (
      parts.length !== 4 ||
      parts[0] !== 'v1' ||
      !/^[a-f0-9]{24}$/.test(parts[1]) ||
      !/^[a-f0-9]{32}$/.test(parts[2]) ||
      ciphertext.length > 512 * 1024
    )
      throw new Error('Invalid ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(parts[1], 'hex'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const input = aiChannelSettingsInputSchema.parse({ ...JSON.parse(plain), revision });
    return { revision, defaultChannelId: input.defaultChannelId, channels: input.channels };
  } catch {
    throw new AppError(503, 'AI 渠道配置无法解密或校验，请恢复原主密钥及配置；没有切换到其他渠道');
  }
}
/** This is global platform configuration, not a tenant's workspace document.
 * The narrow server-only RLS flag is restored even inside an inherited transaction.
 */
async function configurationAccess<T>(operation: () => Promise<T>): Promise<T> {
  return dbTransaction(async () => {
    const before = await query<{ value: string | null }>(
      "SELECT current_setting('app.ai_configuration_access',true) AS value",
    );
    await query("SELECT set_config('app.ai_configuration_access','trusted-server',true)");
    try {
      return await operation();
    } finally {
      await query("SELECT set_config('app.ai_configuration_access',$1,true)", [
        before.rows[0]?.value ?? '',
      ]);
    }
  });
}
export async function loadAIChannelSettings(): Promise<StoredAIChannelSettings | null> {
  if (!saasEnabled()) return null;
  return configurationAccess(async () => {
    const result = await query<{ revision: string | number; encrypted_payload: string }>(
      "SELECT revision,encrypted_payload FROM ai_channel_settings WHERE id='global'",
    );
    const row = result.rows[0];
    return row ? decrypt(row.encrypted_payload, Number(row.revision)) : null;
  });
}
export async function getAIAdminChannelSettings(): Promise<AIAdminChannelSettings> {
  assertAdmin();
  const stored = await loadAIChannelSettings();
  let editable = true;
  try {
    encryptionKey();
  } catch {
    editable = false;
  }
  return {
    revision: stored?.revision ?? 0,
    defaultChannelId: stored?.defaultChannelId ?? 'mock',
    channels: (stored?.channels ?? []).map(({ apiKey, ...channel }) => ({
      ...channel,
      apiKeyConfigured: Boolean(apiKey),
    })),
    presets: AI_PROVIDER_PRESETS,
    storage: stored ? 'database' : 'environment',
    editable,
    realCallsEnabled: process.env.AI_MODE !== 'mock',
  };
}
export async function saveAIChannelSettings(raw: unknown): Promise<AIAdminChannelSettings> {
  assertAdmin();
  encryptionKey();
  const input = aiChannelSettingsInputSchema.parse(raw);
  await configurationAccess(async () => {
    const result = await query<{ revision: string | number; encrypted_payload: string }>(
      "SELECT revision,encrypted_payload FROM ai_channel_settings WHERE id='global' FOR UPDATE",
    );
    const row = result.rows[0];
    const previous = row ? decrypt(row.encrypted_payload, Number(row.revision)) : null;
    if ((previous?.revision ?? 0) !== input.revision)
      throw new AppError(409, 'AI 渠道已由其他管理员更新，请重新读取后再保存');
    const channels = input.channels.map((channel) => {
      const prior = previous?.channels.find((item) => item.id === channel.id);
      const destinationChanged =
        prior && (prior.provider !== channel.provider || prior.baseUrl !== channel.baseUrl);
      if (destinationChanged && !channel.apiKey && prior?.apiKey)
        throw new AppError(400, '修改服务商或 API 地址时必须重新填写该渠道的密钥');
      const apiKey = channel.apiKey ?? prior?.apiKey;
      if (channel.enabled && !apiKey) throw new AppError(400, '启用渠道前请填写该渠道的 API 密钥');
      const preset = providerPreset(channel.provider);
      // Constructor validation does not issue any provider request.
      new OpenAICompatibleProvider({
        ...channel,
        apiKey: apiKey || 'disabled-channel-validation',
        protocol: preset.protocol,
        providerId: channel.provider,
        model: channel.defaultModel,
      });
      return { ...channel, ...(apiKey ? { apiKey } : {}) };
    });
    const encrypted = encrypt({ defaultChannelId: input.defaultChannelId, channels });
    const saved = previous
      ? await query(
          "UPDATE ai_channel_settings SET revision=revision+1,encrypted_payload=$1,updated_by=$2,updated_at=now() WHERE id='global' AND revision=$3 RETURNING revision",
          [encrypted, currentUserId(), input.revision],
        )
      : await query(
          "INSERT INTO ai_channel_settings(id,revision,encrypted_payload,updated_by) VALUES('global',1,$1,$2) ON CONFLICT(id) DO NOTHING RETURNING revision",
          [encrypted, currentUserId()],
        );
    if (saved.rowCount !== 1) throw new AppError(409, 'AI 渠道配置发生冲突，请重新读取');
    await query('INSERT INTO audit_events(id,user_id,action) VALUES($1,$2,$3)', [
      randomUUID(),
      currentUserId(),
      'ai_channels.updated',
    ]);
  });
  return getAIAdminChannelSettings();
}
