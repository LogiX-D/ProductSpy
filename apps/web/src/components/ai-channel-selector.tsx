'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  apiRequest,
  errorMessage,
  type AIChannelCatalog,
  type AISelection,
} from '@productspy/shared';
import {
  ACCOUNT_CHANGED_EVENT,
  getAccountSession,
  isLegacyMode,
  refreshAccountSession,
  webRequest,
} from '../lib/session';
import { Button, ErrorNotice } from './ui';

export type PreparedAISelection = AISelection & {
  mode: 'mock' | 'real';
  channelLabel: string;
  accountId?: string;
};

export function aiSelectionInput(selection: PreparedAISelection): AISelection {
  return {
    ...(selection.channelId ? { channelId: selection.channelId } : {}),
    ...(selection.model ? { model: selection.model } : {}),
  };
}

export function aiSourceLabel(metadata?: {
  channelLabel?: string;
  channelId?: string;
  provider?: string;
  model?: string;
}): string {
  return [metadata?.channelLabel ?? metadata?.channelId ?? metadata?.provider, metadata?.model]
    .filter(Boolean)
    .join(' · ');
}

export function useAIChannels() {
  const [state, setState] = useState<{
    owner?: string;
    catalog?: AIChannelCatalog;
    channelId?: string;
    model?: string;
    error: string;
    loading: boolean;
  }>({ error: '', loading: true });
  const sequence = useRef(0);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setState({ error: '', loading: true });
    try {
      if (isLegacyMode) {
        const { mode } = await apiRequest<{ mode: 'mock' | 'real' }>('/api/status');
        if (mode !== 'mock' && mode !== 'real') throw new Error('AI 服务模式无效');
        if (alive.current && request === sequence.current)
          setState({
            catalog: {
              defaultChannelId: 'legacy',
              canManage: false,
              channels: [
                {
                  id: 'legacy',
                  label: mode === 'mock' ? '本机 Mock 演示' : '本机 AI 配置',
                  provider: mode === 'mock' ? 'mock' : 'custom',
                  mode,
                  models: [],
                  defaultModel: '',
                },
              ],
            },
            channelId: 'legacy',
            model: '',
            error: '',
            loading: false,
          });
        return;
      }
      const account = await refreshAccountSession();
      if (!alive.current || request !== sequence.current) return;
      const owner = account.user.id;
      const catalog = await webRequest<AIChannelCatalog>('/api/ai/channels');
      if (!alive.current || request !== sequence.current || getAccountSession()?.user.id !== owner)
        return;
      const initial = catalog.channels.find((channel) => channel.id === catalog.defaultChannelId);
      if (!initial || !initial.models.some((model) => model.id === initial.defaultModel))
        throw new Error('管理员尚未提供有效的 AI 渠道和模型');
      setState({
        owner,
        catalog,
        channelId: initial.id,
        model: initial.defaultModel,
        error: '',
        loading: false,
      });
    } catch (cause) {
      if (alive.current && request === sequence.current)
        setState({
          error: `无法确认工作台的 AI 模式或渠道：${errorMessage(cause)}`,
          loading: false,
        });
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    const changed = () => {
      void reload();
    };
    if (!isLegacyMode) window.addEventListener(ACCOUNT_CHANGED_EVENT, changed);
    return () => {
      alive.current = false;
      sequence.current += 1;
      if (!isLegacyMode) window.removeEventListener(ACCOUNT_CHANGED_EVENT, changed);
    };
  }, [reload]);
  const verified =
    isLegacyMode || (state.owner !== undefined && state.owner === getAccountSession()?.user.id);
  const catalog = verified ? state.catalog : undefined;
  const channel = catalog?.channels.find((item) => item.id === state.channelId);
  const mode = channel?.mode;
  function freeze(): PreparedAISelection | undefined {
    if (
      !channel ||
      !mode ||
      !verified ||
      (!isLegacyMode && !channel.models.some((model) => model.id === state.model))
    )
      return undefined;
    return {
      ...(!isLegacyMode
        ? { channelId: channel.id, model: state.model, accountId: state.owner }
        : {}),
      mode,
      channelLabel: channel.label,
    };
  }
  function isCurrent(selection: PreparedAISelection): boolean {
    return (
      isLegacyMode ||
      (selection.accountId !== undefined && selection.accountId === getAccountSession()?.user.id)
    );
  }
  return {
    catalog,
    channel,
    mode,
    model: state.model,
    error: state.error,
    loading: state.loading,
    reload,
    freeze,
    isCurrent,
    selectChannel: (id: string) => {
      const next = catalog?.channels.find((item) => item.id === id);
      if (next)
        setState((current) => ({ ...current, channelId: next.id, model: next.defaultModel }));
    },
    selectModel: (id: string) => {
      if (channel?.models.some((model) => model.id === id))
        setState((current) => ({ ...current, model: id }));
    },
  };
}

export function AIChannelSelector({
  controller,
  disabled = false,
}: {
  controller: ReturnType<typeof useAIChannels>;
  disabled?: boolean;
}) {
  if (isLegacyMode) return null;
  return (
    <section className="creation-panel" aria-label="AI 渠道与模型">
      <div className="creation-panel-heading">
        <div>
          <h3>AI 渠道与模型</h3>
          <p className="creation-note">
            渠道由管理员统一配置。本次请求使用所选渠道，不会自动切换或重试。
          </p>
        </div>
        {controller.catalog?.canManage && <Link href="/settings/ai">管理 AI 渠道</Link>}
      </div>
      {controller.error && (
        <ErrorNotice message={controller.error} onRetry={() => void controller.reload()} />
      )}
      {controller.loading && <p role="status">正在读取可用渠道…</p>}
      {controller.catalog && (
        <div className="creation-actions">
          <label className="creation-field">
            AI 渠道
            <select
              aria-label="AI 渠道"
              value={controller.channel?.id ?? ''}
              disabled={disabled}
              onChange={(event) => controller.selectChannel(event.target.value)}
            >
              {controller.catalog.channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.label}
                  {channel.mode === 'mock' ? ' · Mock 演示' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="creation-field">
            模型
            <select
              aria-label="AI 模型"
              value={controller.model ?? ''}
              disabled={disabled}
              onChange={(event) => controller.selectModel(event.target.value)}
            >
              {controller.channel?.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="ghost"
            disabled={disabled || controller.loading}
            onClick={() => void controller.reload()}
          >
            刷新渠道
          </Button>
        </div>
      )}
    </section>
  );
}
