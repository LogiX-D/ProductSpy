'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  aiChannelSettingsInputSchema,
  errorMessage,
  type AIAdminChannelSettings,
  type AIChannelInput,
  type AIProviderPreset,
} from '@productspy/shared';
import { getAccountSession, isLegacyMode, webRequest } from '../lib/session';
import { useAccount } from './saas-access';
import { Button, ErrorNotice } from './ui';

type ChannelDraft = Omit<AIChannelInput, 'models' | 'apiKey'> & {
  modelText: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  existing: boolean;
};
function draftsFrom(settings: AIAdminChannelSettings): ChannelDraft[] {
  return settings.channels.map(({ models, ...channel }) => ({
    ...channel,
    modelText: models.map((model) => model.id).join('\n'),
    apiKey: '',
    existing: true,
  }));
}

export function AIChannelAdmin() {
  const owner = useAccount()?.user.id;
  const [settings, setSettings] = useState<AIAdminChannelSettings>();
  const [drafts, setDrafts] = useState<ChannelDraft[]>([]);
  const [defaultId, setDefaultId] = useState('mock');
  const [presetId, setPresetId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  useEffect(() => {
    const revision = ++request.current;
    setSettings(undefined);
    setDrafts([]);
    setError('');
    setMessage('');
    setDenied(false);
    setLoading(true);
    if (isLegacyMode || !owner) {
      setLoading(false);
      return;
    }
    void webRequest<AIAdminChannelSettings>('/api/admin/ai-channels')
      .then((value) => {
        if (
          request.current !== revision ||
          currentOwner.current !== owner ||
          getAccountSession()?.user.id !== owner
        )
          return;
        setSettings(value);
        setDrafts(draftsFrom(value));
        setDefaultId(value.defaultChannelId);
        setPresetId(value.presets[0]?.id ?? '');
      })
      .catch((cause: unknown) => {
        if (request.current !== revision || currentOwner.current !== owner) return;
        if (cause instanceof ApiRequestError && (cause.status === 403 || cause.status === 404))
          setDenied(true);
        else setError(errorMessage(cause));
      })
      .finally(() => {
        if (request.current === revision) setLoading(false);
      });
    return () => {
      request.current += 1;
    };
  }, [owner, attempt]);
  const editable = Boolean(settings?.editable && !saving);
  function patch(index: number, value: Partial<ChannelDraft>) {
    setDrafts((current) =>
      current.map((channel, position) => (position === index ? { ...channel, ...value } : channel)),
    );
    setMessage('');
  }
  function add(preset: AIProviderPreset) {
    if (!editable || drafts.length >= 20) return;
    let suffix = 1;
    while (drafts.some((channel) => channel.id === `${preset.id}-${suffix}`)) suffix += 1;
    setDrafts((current) => [
      ...current,
      {
        id: `${preset.id}-${suffix}`,
        label: preset.label,
        provider: preset.id,
        baseUrl: preset.baseUrl,
        enabled: false,
        defaultModel: '',
        modelText: '',
        apiKey: '',
        apiKeyConfigured: false,
        existing: false,
        responseFormat: preset.protocol === 'anthropic' ? 'text' : 'json_object',
        tokenParameter: 'max_tokens',
        timeoutMs: 60000,
        maxOutputTokens: 8192,
      },
    ]);
  }
  async function save() {
    if (!settings?.editable || saving || !owner || getAccountSession()?.user.id !== owner) return;
    const parsed = aiChannelSettingsInputSchema.safeParse({
      revision: settings.revision,
      defaultChannelId: defaultId,
      channels: drafts.map(
        ({
          modelText,
          apiKey,
          apiKeyConfigured: _configured,
          existing: _existing,
          ...channel
        }) => ({
          ...channel,
          models: modelText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((id) => ({ id, label: id })),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      ),
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`).join('；'),
      );
      return;
    }
    const revision = ++request.current;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await webRequest<AIAdminChannelSettings>('/api/admin/ai-channels', {
        method: 'PUT',
        body: JSON.stringify(parsed.data),
      });
      if (
        request.current !== revision ||
        currentOwner.current !== owner ||
        getAccountSession()?.user.id !== owner
      )
        return;
      setSettings(result);
      setDrafts(draftsFrom(result));
      setDefaultId(result.defaultChannelId);
      setMessage('渠道配置已保存，密钥输入已清空。此次保存没有调用 AI。');
    } catch (cause) {
      if (request.current === revision && currentOwner.current === owner)
        setError(errorMessage(cause));
    } finally {
      if (request.current === revision) setSaving(false);
    }
  }
  return (
    <div className="creation-workspace">
      <header className="creation-panel">
        <h1>AI 渠道管理</h1>
        <p className="creation-note">
          管理员统一配置服务商和可用模型，用户在生成时选择。密钥仅在服务端保存，普通用户无法读取。
        </p>
      </header>
      {loading && <p role="status">正在验证管理员权限…</p>}
      {(denied || isLegacyMode || (!owner && !loading)) && (
        <p role="status">
          此页面仅供已授权的 SaaS 管理员使用。如需管理权限，请由运维配置管理员账号 UUID。
        </p>
      )}
      {error && (
        <ErrorNotice
          message={error}
          onRetry={!settings ? () => setAttempt((value) => value + 1) : undefined}
        />
      )}
      {message && (
        <p role="status" className="creation-notice">
          {message}
        </p>
      )}
      {settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          autoComplete="off"
        >
          {!settings.editable && (
            <p className="creation-notice">
              当前仅可查看配置。请运维配置 PRODUCTSPY_AI_ADMIN_IDS 管理员 UUID 和
              PRODUCTSPY_AI_CHANNEL_SECRET 加密主密钥后启用管理。
            </p>
          )}
          {!settings.realCallsEnabled && (
            <p className="creation-notice">
              真实 AI 调用当前关闭（AI_MODE=mock）。可以准备并保存配置，用户暂时只看到 Mock
              演示；启用真实调用需运维配置及测试预算。
            </p>
          )}
          <section className="creation-panel">
            <h2>默认渠道</h2>
            <label className="creation-field">
              新请求默认使用
              <select
                aria-label="默认 AI 渠道"
                value={defaultId}
                disabled={!editable}
                onChange={(event) => setDefaultId(event.target.value)}
              >
                <option value="mock">Mock 演示</option>
                {drafts
                  .filter((channel) => channel.enabled)
                  .map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.label || channel.id}
                    </option>
                  ))}
              </select>
            </label>
            <p className="creation-note">
              保存配置不会测试模型、产生收费调用或自动重发已有任务。已有历史继续显示当时使用的渠道与模型。
            </p>
          </section>
          {drafts.map((channel, index) => (
            <section className="creation-panel" key={index} aria-label={`渠道 ${index + 1}`}>
              <div className="creation-panel-heading">
                <h2>{channel.label || `渠道 ${index + 1}`}</h2>
                <Button
                  variant="danger"
                  disabled={!editable}
                  onClick={() => {
                    if (
                      window.confirm(
                        `移除渠道“${channel.label || channel.id}”？仅影响后续请求，已有历史保留。`,
                      )
                    ) {
                      setDrafts((current) => current.filter((_, position) => position !== index));
                      if (defaultId === channel.id) setDefaultId('mock');
                    }
                  }}
                >
                  移除渠道
                </Button>
              </div>
              <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
                <div className="creation-checks">
                  <label>
                    <input
                      type="checkbox"
                      checked={channel.enabled}
                      onChange={(event) => patch(index, { enabled: event.target.checked })}
                    />
                    启用渠道
                  </label>
                </div>
                <label className="creation-field">
                  名称
                  <input
                    aria-label={`渠道 ${index + 1} 名称`}
                    value={channel.label}
                    maxLength={80}
                    onChange={(event) => patch(index, { label: event.target.value })}
                  />
                </label>
                <label className="creation-field">
                  渠道 ID
                  <input
                    aria-label={`渠道 ${index + 1} ID`}
                    value={channel.id}
                    readOnly={channel.existing}
                    maxLength={64}
                    onChange={(event) => patch(index, { id: event.target.value })}
                  />
                </label>
                <label className="creation-field">
                  服务商
                  <select
                    aria-label={`渠道 ${index + 1} 服务商`}
                    value={channel.provider}
                    onChange={(event) => {
                      const preset = settings.presets.find(
                        (item) => item.id === event.target.value,
                      );
                      if (preset) patch(index, { provider: preset.id, baseUrl: preset.baseUrl });
                    }}
                  >
                    {settings.presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="creation-field">
                  API 地址
                  <input
                    aria-label={`渠道 ${index + 1} API 地址`}
                    type="url"
                    value={channel.baseUrl}
                    maxLength={2048}
                    onChange={(event) => patch(index, { baseUrl: event.target.value })}
                  />
                </label>
                <label className="creation-field">
                  可用模型（每行一个模型 ID）
                  <textarea
                    aria-label={`渠道 ${index + 1} 模型列表`}
                    rows={4}
                    value={channel.modelText}
                    maxLength={6030}
                    onChange={(event) => patch(index, { modelText: event.target.value })}
                  />
                </label>
                <label className="creation-field">
                  默认模型
                  <input
                    aria-label={`渠道 ${index + 1} 默认模型`}
                    value={channel.defaultModel}
                    maxLength={200}
                    onChange={(event) => patch(index, { defaultModel: event.target.value })}
                  />
                </label>
                <label className="creation-field">
                  API Key · {channel.apiKeyConfigured ? '已配置，留空保留现有密钥' : '尚未配置'}
                  <input
                    aria-label={`渠道 ${index + 1} API Key`}
                    type="password"
                    autoComplete="new-password"
                    value={channel.apiKey}
                    maxLength={8192}
                    onChange={(event) => patch(index, { apiKey: event.target.value })}
                  />
                </label>
                <details>
                  <summary>高级兼容参数</summary>
                  <label className="creation-field">
                    输出格式
                    <select
                      value={channel.responseFormat}
                      onChange={(event) =>
                        patch(index, {
                          responseFormat: event.target.value as AIChannelInput['responseFormat'],
                        })
                      }
                    >
                      {['json_object', 'json_schema', 'text'].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label className="creation-field">
                    Token 参数
                    <select
                      value={channel.tokenParameter}
                      onChange={(event) =>
                        patch(index, {
                          tokenParameter: event.target.value as AIChannelInput['tokenParameter'],
                        })
                      }
                    >
                      <option>max_tokens</option>
                      <option>max_completion_tokens</option>
                    </select>
                  </label>
                  <label className="creation-field">
                    请求超时（毫秒）
                    <input
                      type="number"
                      min={1}
                      max={120000}
                      value={channel.timeoutMs}
                      onChange={(event) => patch(index, { timeoutMs: Number(event.target.value) })}
                    />
                  </label>
                  <label className="creation-field">
                    最大输出 Token
                    <input
                      type="number"
                      min={256}
                      max={32768}
                      value={channel.maxOutputTokens}
                      onChange={(event) =>
                        patch(index, { maxOutputTokens: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label className="creation-field">
                    Temperature（留空使用服务默认）
                    <input
                      type="number"
                      step="0.1"
                      min={0}
                      max={2}
                      value={channel.temperature ?? ''}
                      onChange={(event) =>
                        patch(index, {
                          temperature:
                            event.target.value === '' ? undefined : Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="creation-field">
                    深度思考
                    <select
                      value={channel.thinking ?? ''}
                      onChange={(event) =>
                        patch(index, {
                          thinking: event.target.value
                            ? (event.target.value as 'enabled' | 'disabled')
                            : undefined,
                        })
                      }
                    >
                      <option value="">服务默认</option>
                      <option value="disabled">关闭</option>
                      <option value="enabled">开启</option>
                    </select>
                  </label>
                </details>
              </fieldset>
            </section>
          ))}
          <section className="creation-panel">
            <h2>添加服务商</h2>
            <div className="creation-actions">
              <label className="creation-field">
                服务商预设
                <select
                  aria-label="服务商预设"
                  value={presetId}
                  disabled={!editable || drafts.length >= 20}
                  onChange={(event) => setPresetId(event.target.value)}
                >
                  {settings.presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="secondary"
                disabled={!editable || drafts.length >= 20 || !presetId}
                onClick={() => {
                  const preset = settings.presets.find((item) => item.id === presetId);
                  if (preset) add(preset);
                }}
              >
                添加渠道
              </Button>
            </div>
            <p className="creation-note">
              最多 20 个渠道，每个渠道最多 30 个模型。请根据服务商账号实际可用的模型 ID 配置。
            </p>
            <Button type="submit" disabled={!editable}>
              {saving ? '正在保存…' : '保存渠道配置'}
            </Button>
          </section>
        </form>
      )}
    </div>
  );
}
