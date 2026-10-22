// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIChannelCatalog } from '@productspy/shared';
import {
  AIChannelSelector,
  aiSelectionInput,
  aiSourceLabel,
  useAIChannels,
  type PreparedAISelection,
} from './ai-channel-selector';

const stubs = vi.hoisted(() => ({ owner: 'account-a', request: vi.fn(), status: vi.fn() }));
vi.mock('../lib/session', () => ({
  isLegacyMode: false,
  ACCOUNT_CHANGED_EVENT: 'test-account-changed',
  getAccountSession: () => ({ user: { id: stubs.owner } }),
  refreshAccountSession: async () => ({ user: { id: stubs.owner } }),
  webRequest: stubs.request,
}));
vi.mock('@productspy/shared', async (original) => ({
  ...(await original<typeof import('@productspy/shared')>()),
  apiRequest: stubs.status,
}));
const catalog: AIChannelCatalog = {
  defaultChannelId: 'main',
  canManage: true,
  channels: [
    {
      id: 'main',
      label: '团队 DeepSeek',
      provider: 'deepseek',
      mode: 'real',
      models: [
        { id: 'reasoner', label: '推理模型' },
        { id: 'chat', label: '对话模型' },
      ],
      defaultModel: 'chat',
    },
    {
      id: 'mock',
      label: 'Mock',
      provider: 'mock',
      mode: 'mock',
      models: [{ id: 'mock', label: 'Mock 示例' }],
      defaultModel: 'mock',
    },
  ],
};
let controller: ReturnType<typeof useAIChannels>;
function Harness() {
  controller = useAIChannels();
  return createElement(AIChannelSelector, { controller });
}
describe('account scoped AI channel selection', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    stubs.owner = 'account-a';
    stubs.request.mockReset().mockResolvedValue(catalog);
    stubs.status.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render() {
    await act(async () => root.render(createElement(Harness)));
  }
  it('uses the account catalog and freezes mode and model without passing private configuration', async () => {
    await render();
    expect(stubs.request).toHaveBeenCalledWith('/api/ai/channels');
    expect(stubs.status).not.toHaveBeenCalled();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/settings/ai');
    await act(async () => controller.selectModel('reasoner'));
    const prepared = controller.freeze()!;
    await act(async () => controller.selectChannel('mock'));
    expect(controller.mode).toBe('mock');
    expect(prepared.mode).toBe('real');
    expect(aiSelectionInput(prepared)).toEqual({ channelId: 'main', model: 'reasoner' });
    expect(aiSelectionInput(prepared)).not.toHaveProperty('accountId');
    expect(aiSelectionInput(prepared)).not.toHaveProperty('mode');
    expect(controller.isCurrent(prepared)).toBe(true);
    stubs.owner = 'account-b';
    expect(controller.isCurrent(prepared)).toBe(false);
  });
  it('drops an old account response even when it arrives after the new catalog', async () => {
    let resolveOld!: (value: AIChannelCatalog) => void;
    stubs.request.mockImplementationOnce(
      () =>
        new Promise<AIChannelCatalog>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await render();
    stubs.owner = 'account-b';
    stubs.request.mockResolvedValue({
      ...catalog,
      canManage: false,
      channels: [{ ...catalog.channels[0], id: 'b', label: 'B 账号专属' }],
      defaultChannelId: 'b',
    });
    await act(async () => window.dispatchEvent(new Event('test-account-changed')));
    expect(container.textContent).toContain('B 账号专属');
    await act(async () => resolveOld(catalog));
    expect(container.textContent).not.toContain('团队 DeepSeek');
    expect(container.querySelector('a')).toBeNull();
    expect(controller.freeze()?.accountId).toBe('account-b');
  });
  it('does not silently choose Mock when catalog loading fails', async () => {
    stubs.request.mockRejectedValue(new Error('offline'));
    await render();
    expect(controller.mode).toBeUndefined();
    expect(controller.freeze()).toBeUndefined();
    expect(container.querySelector('select')).toBeNull();
    expect(container.textContent).toContain('offline');
  });
  it('describes history from recorded metadata instead of the current selector', () => {
    expect(aiSourceLabel({ channelLabel: '当时渠道', model: 'old-model' })).toBe(
      '当时渠道 · old-model',
    );
    expect(aiSourceLabel({ provider: 'anthropic', model: 'old-model' })).toBe(
      'anthropic · old-model',
    );
    expect(aiSourceLabel()).toBe('');
    expect(aiSelectionInput({ mode: 'mock', channelLabel: '演示' } as PreparedAISelection)).toEqual(
      {},
    );
  });
});
