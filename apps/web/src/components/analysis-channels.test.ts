// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIChannelCatalog, Product } from '@productspy/shared';
import { AnalysisPanel } from './analysis-panel';
const stubs = vi.hoisted(() => ({ owner: 'account-a', request: vi.fn(), update: vi.fn() }));
vi.mock('../lib/session', () => ({
  isLegacyMode: false,
  ACCOUNT_CHANGED_EVENT: 'test-account-changed',
  getAccountSession: () => ({ user: { id: stubs.owner } }),
  refreshAccountSession: async () => ({ user: { id: stubs.owner } }),
  webRequest: stubs.request,
}));
vi.mock('../lib/storage/product-api', () => ({ productRepository: { get: vi.fn() } }));
const catalog: AIChannelCatalog = {
  defaultChannelId: 'real',
  canManage: false,
  channels: [
    {
      id: 'real',
      label: '原渠道',
      provider: 'deepseek',
      mode: 'real',
      models: [
        { id: 'reasoner', label: '推理' },
        { id: 'chat', label: '对话' },
      ],
      defaultModel: 'chat',
    },
    {
      id: 'mock',
      label: '演示',
      provider: 'mock',
      mode: 'mock',
      models: [{ id: 'mock', label: 'Mock' }],
      defaultModel: 'mock',
    },
  ],
};
const product: Product = {
  id: 'test-product',
  source: 'amazon',
  sourceId: 'B000000001',
  url: 'https://www.amazon.com/dp/B000000001',
  title: 'Bottle',
  images: [],
  videos: [],
  bulletPoints: [],
  createdAt: '2026-10-09T01:00:00.000Z',
  updatedAt: '2026-10-09T01:00:00.000Z',
};
describe('frozen channel authorization in SaaS analysis', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value() {
        this.removeAttribute('open');
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value() {},
    });
    sessionStorage.clear();
    localStorage.clear();
    stubs.owner = 'account-a';
    stubs.request.mockReset().mockImplementation((path: string) =>
      path === '/api/ai/channels'
        ? Promise.resolve(catalog)
        : path === '/api/analyze-product'
          ? Promise.reject(new Error('fixture transport failure'))
          : Promise.resolve({
              records: [],
              totals: {
                requests: 0,
                realRequests: 0,
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                unknownTokenRequests: 0,
                unknownCostRequests: 0,
              },
              limits: { dailyRealRequests: 0, dailyLimit: 20 },
            }),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render() {
    await act(async () =>
      root.render(createElement(AnalysisPanel, { product, onUpdate: stubs.update })),
    );
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === label,
    );
    if (!button) throw new Error(`missing ${label}`);
    await act(async () => button.click());
  }
  const calls = () => stubs.request.mock.calls.filter(([path]) => path === '/api/analyze-product');
  it('keeps original real channel and model when the selector changes during confirmation', async () => {
    await render();
    await click('开始 AI 分析');
    expect(calls()).toHaveLength(0);
    const select = container.querySelector<HTMLSelectElement>('[aria-label="AI 渠道"]')!;
    await act(async () => {
      select.value = 'mock';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('dialog')?.textContent).toContain('原渠道 · chat');
    await click('授权本次调用');
    expect(calls()).toHaveLength(1);
    const payload = JSON.parse(String((calls()[0][1] as RequestInit).body));
    expect(payload).toMatchObject({ channelId: 'real', model: 'chat', authorizeReal: true });
    expect(payload).not.toHaveProperty('apiKey');
    expect(payload).not.toHaveProperty('mode');
    expect(payload).not.toHaveProperty('accountId');
  });
  it('rejects a prepared request after the account changes', async () => {
    await render();
    await click('开始 AI 分析');
    stubs.owner = 'account-b';
    await act(async () => window.dispatchEvent(new Event('test-account-changed')));
    await click('授权本次调用');
    expect(calls()).toHaveLength(0);
    expect(container.textContent).toContain('账号已切换');
  });
});
