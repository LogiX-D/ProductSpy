// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type AIAdminChannelSettings } from '@productspy/shared';
import { AIChannelAdmin } from './ai-channel-admin';
const stubs = vi.hoisted(() => ({ owner: 'admin-a', request: vi.fn() }));
vi.mock('../lib/session', () => ({
  isLegacyMode: false,
  getAccountSession: () => ({ user: { id: stubs.owner } }),
  webRequest: stubs.request,
}));
vi.mock('./saas-access', () => ({ useAccount: () => ({ user: { id: stubs.owner } }) }));
const settings: AIAdminChannelSettings = {
  revision: 1,
  defaultChannelId: 'mock',
  editable: true,
  storage: 'database',
  realCallsEnabled: false,
  channels: [
    {
      id: 'team-ai',
      label: '团队 AI',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      models: [{ id: 'deepseek-chat', label: 'deepseek-chat' }],
      defaultModel: 'deepseek-chat',
      enabled: false,
      responseFormat: 'json_object',
      tokenParameter: 'max_tokens',
      timeoutMs: 60000,
      maxOutputTokens: 8192,
      apiKeyConfigured: true,
    },
  ],
  presets: [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai-compatible',
      documentationUrl: 'https://api-docs.deepseek.com',
    },
  ],
};
describe('administrator AI configuration', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    stubs.owner = 'admin-a';
    stubs.request.mockReset().mockResolvedValue(settings);
    sessionStorage.clear();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render() {
    await act(async () => root.render(createElement(AIChannelAdmin)));
  }
  async function submit() {
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  }
  it('retains configured secrets when the password field is blank and never calls AI on save', async () => {
    await render();
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
    expect(container.textContent).toContain('真实 AI 调用当前关闭');
    await submit();
    const calls = stubs.request.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String((calls[0][1] as RequestInit).body));
    expect(body.channels[0]).not.toHaveProperty('apiKey');
    expect(stubs.request.mock.calls.every(([path]) => path === '/api/admin/ai-channels')).toBe(
      true,
    );
    expect(container.textContent).toContain('此次保存没有调用 AI');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('clears the write-only secret field after a successful save', async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'fixture-key-only');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit();
    const save = stubs.request.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    )!;
    expect(JSON.parse(String((save[1] as RequestInit).body)).channels[0].apiKey).toBe(
      'fixture-key-only',
    );
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
    expect(container.textContent).not.toContain('fixture-key-only');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('does not show a configuration or key form to an ordinary account', async () => {
    stubs.request.mockRejectedValue(new ApiRequestError('forbidden', 403));
    await render();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain('仅供已授权');
  });
  it('disables editing until operations configures the administrator and encryption key', async () => {
    stubs.request.mockResolvedValue({ ...settings, editable: false });
    await render();
    expect(container.textContent).toContain('PRODUCTSPY_AI_CHANNEL_SECRET');
    expect(container.querySelector('fieldset')?.disabled).toBe(true);
    await submit();
    expect(stubs.request.mock.calls).toHaveLength(1);
  });
  it('ignores a stale administrator response after switching accounts', async () => {
    let old!: (value: AIAdminChannelSettings) => void;
    stubs.request.mockImplementationOnce(
      () =>
        new Promise<AIAdminChannelSettings>((resolve) => {
          old = resolve;
        }),
    );
    await render();
    stubs.owner = 'ordinary-b';
    stubs.request.mockRejectedValue(new ApiRequestError('forbidden', 403));
    await render();
    await act(async () => old(settings));
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).not.toContain('团队 AI');
  });
});
