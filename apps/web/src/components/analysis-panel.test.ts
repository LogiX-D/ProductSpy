// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisGenerationResponse, Product, ProductAnalysis } from '@productspy/shared';
import { AnalysisPanel } from './analysis-panel';

const stubs = vi.hoisted(() => ({
  status: vi.fn(),
  request: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  get: vi.fn(),
}));
vi.mock('@productspy/shared', async (original) => ({
  ...(await original<typeof import('@productspy/shared')>()),
  apiRequest: stubs.status,
}));
vi.mock('../lib/session', () => ({
  webRequest: stubs.request,
  isLegacyMode: true,
  getAccountSession: () => undefined,
}));
vi.mock('../lib/storage/product-api', () => ({
  productRepository: { saveAnalysis: stubs.save, restoreAnalysis: stubs.restore, get: stubs.get },
}));

const product: Product = {
  id: 'ui-authorized',
  source: 'amazon',
  sourceId: 'B000000001',
  url: 'https://www.amazon.com/dp/B000000001',
  title: 'Travel Bottle',
  images: ['https://m.media-amazon.com/images/I/bottle.jpg'],
  videos: [],
  bulletPoints: ['Sealed lid'],
  createdAt: '2026-10-09T01:00:00.000Z',
  updatedAt: '2026-10-09T01:00:00.000Z',
};
const analysis: ProductAnalysis = {
  summary: '页面资料中的水杯',
  sellingPoints: ['密封杯盖'],
  targetAudience: ['通勤用户'],
  purchaseMotivations: ['随身饮水'],
  painPoints: ['携带不方便'],
  strengths: ['杯盖设计'],
  weaknesses: ['保温表现待验证'],
  marketingAngles: ['出门准备'],
  hooks: ['一', '二', '三', '四', '五'],
  shortVideoScript:
    'Hook: 带水出门\nProblem: 携带不便\nSolution: 水杯\nDemo: 展示杯盖\nCTA: 查看详情',
  imagePrompts: ['桌面水杯'],
  videoPrompts: ['打开杯盖'],
};
const response: AnalysisGenerationResponse = {
  product: { ...product, updatedAt: '2026-10-09T01:01:00.000Z', aiAnalysis: analysis },
  analysis,
  metadata: {
    mode: 'real',
    model: 'authorized-stub',
    generatedAt: '2026-10-09T01:01:00.000Z',
    sourceUpdatedAt: product.updatedAt,
    options: {
      market: 'US',
      language: 'zh-CN',
      platform: 'TikTok',
      style: 'casual',
      duration: 30,
      goal: 'consideration',
      customInstructions: '',
    },
    evidence: {
      facts: ['Sealed lid'],
      inferences: ['通勤场景'],
      unknowns: ['未采集评论正文'],
      reviewTextAnalyzed: false,
    },
  },
  requestId: 'a4cd6d0b-54b5-4f13-bd92-bfa6da8fc207',
  replayed: false,
};

describe('explicit AI request authorization', () => {
  let root: Root;
  let container: HTMLDivElement;
  const onUpdate = vi.fn();
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
    stubs.status.mockReset().mockResolvedValue({ mode: 'real' });
    stubs.request.mockReset().mockImplementation((path: string) =>
      path === '/api/analyze-product'
        ? Promise.resolve(response)
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
            limits: { dailyLimit: 20, dailyRealRequests: 0, maxConcurrent: 1 },
          }),
    );
    onUpdate.mockReset();
    stubs.get.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render(value = product) {
    await act(async () => root.render(createElement(AnalysisPanel, { product: value, onUpdate })));
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Button missing: ${label}`);
    await act(async () => button.click());
  }
  const generationCalls = () =>
    stubs.request.mock.calls.filter(([path]) => path === '/api/analyze-product');

  it('does not issue a real request on mount, opening the confirmation or cancelling', async () => {
    await render();
    expect(generationCalls()).toHaveLength(0);
    await click('开始 AI 分析');
    expect(container.querySelector('dialog')?.textContent).toContain('费用未知');
    expect(container.querySelector('dialog')?.textContent).toContain('图片和视频不会上传');
    expect(generationCalls()).toHaveLength(0);
    await click('取消');
    expect(generationCalls()).toHaveLength(0);
    expect(container.querySelector('dialog')).toBeNull();
  });
  it('issues exactly one authorized envelope after explicit approval and never sends analysis history', async () => {
    const prior = {
      ...product,
      aiAnalysis: analysis,
      analysisMetadata: response.metadata,
      analysisHistory: [
        {
          id: response.requestId,
          createdAt: product.updatedAt,
          kind: 'generated' as const,
          analysis,
        },
      ],
    };
    await render(prior);
    await click('重新生成分析');
    await click('确认重新生成');
    expect(generationCalls()).toHaveLength(0);
    await click('授权本次调用');
    expect(generationCalls()).toHaveLength(1);
    const call = generationCalls()[0][1] as RequestInit;
    const payload = JSON.parse(String(call.body));
    expect(payload.authorizeReal).toBe(true);
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.options.market).toBe('US');
    expect(payload.product).not.toHaveProperty('analysisHistory');
    expect(payload.product).not.toHaveProperty('aiAnalysis');
    expect(payload.product).not.toHaveProperty('analysisMetadata');
    expect(onUpdate).toHaveBeenCalledWith(response.product);
  });
  it('requires no fee authorization for local Mock mode', async () => {
    stubs.status.mockResolvedValue({ mode: 'mock' });
    await render();
    await click('开始 AI 分析');
    expect(generationCalls()).toHaveLength(1);
    const call = generationCalls()[0][1] as RequestInit;
    expect(JSON.parse(String(call.body)).authorizeReal).toBe(false);
  });
  it('prevents generation when service mode cannot be determined', async () => {
    stubs.status.mockRejectedValue(new Error('offline'));
    await render();
    const button = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '开始 AI 分析',
    );
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain('无法确认工作台的 AI 模式');
    expect(generationCalls()).toHaveLength(0);
  });

  it('checks a lost response by request identifier without replaying AI or replacing a later manual edit', async () => {
    stubs.request.mockImplementation((path: string) =>
      path === '/api/analyze-product'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve({
            records: [],
            totals: {
              requests: 1,
              realRequests: 1,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              unknownTokenRequests: 1,
              unknownCostRequests: 1,
            },
            limits: { dailyLimit: 20, dailyRealRequests: 1, maxConcurrent: 1 },
          }),
    );
    await render();
    await click('开始 AI 分析');
    await click('授权本次调用');
    expect(generationCalls()).toHaveLength(1);
    const requestId = JSON.parse(String((generationCalls()[0][1] as RequestInit).body))
      .requestId as string;
    const marker = JSON.parse(
      sessionStorage.getItem(`productspy:analysis-request:v1:${product.id}`)!,
    );
    expect(marker.requestId).toBe(requestId);
    expect(container.textContent).toContain('服务商仍可能已生成并计费');
    const latest: Product = {
      ...response.product,
      updatedAt: '2026-10-09T01:03:00.000Z',
      aiAnalysis: { ...analysis, summary: '后续人工编辑必须保留' },
      analysisHistory: [
        {
          id: requestId,
          createdAt: response.metadata.generatedAt,
          kind: 'generated',
          analysis,
          metadata: { ...response.metadata, requestId },
        },
      ],
    };
    stubs.get.mockResolvedValue(latest);
    await click('检查上次请求结果');
    expect(stubs.get).toHaveBeenCalledWith(product.id);
    expect(generationCalls()).toHaveLength(1);
    expect(onUpdate).toHaveBeenCalledWith(latest);
    await render(latest);
    expect(container.querySelector('#analysis-summary')?.textContent).toContain(
      '后续人工编辑必须保留',
    );
    expect(sessionStorage.getItem(`productspy:analysis-request:v1:${product.id}`)).toBeNull();
    expect(container.textContent).not.toContain('上次请求结果尚未确认');
  });

  it('keeps unknown-result recovery across remounts and requires new explicit approval before another request', async () => {
    stubs.request.mockImplementation((path: string) =>
      path === '/api/analyze-product'
        ? Promise.reject(new DOMException('Timed out', 'TimeoutError'))
        : Promise.resolve({
            records: [],
            totals: {
              requests: 1,
              realRequests: 1,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              unknownTokenRequests: 1,
              unknownCostRequests: 1,
            },
            limits: { dailyLimit: 20, dailyRealRequests: 1, maxConcurrent: 1 },
          }),
    );
    stubs.get.mockResolvedValue(product);
    await render();
    await click('开始 AI 分析');
    await click('授权本次调用');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.textContent).toContain('上次请求结果尚未确认');
    await click('检查上次请求结果');
    expect(container.textContent).toContain('网络中断或超时不能证明服务商没有计费');
    expect(generationCalls()).toHaveLength(1);
    await click('开始 AI 分析');
    expect(container.querySelector('dialog')?.textContent).toContain('继续将创建一个新请求');
    await click('确认重新生成');
    expect(container.querySelector('dialog')?.textContent).toContain('可能再次计费');
    expect(generationCalls()).toHaveLength(1);
    await click('取消');
    expect(generationCalls()).toHaveLength(1);
  });
});
