// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductDraft } from '@productspy/shared';
import { App } from './App';
import { extensionRequest, type ExtensionResponse } from '../background/messages';
import { hasCaptureConsent, rememberCaptureConsent } from './capture-consent';

vi.mock('../background/messages', () => ({
  WORKSPACE_URL: 'http://127.0.0.1:3000',
  extensionRequest: vi.fn(),
}));
vi.mock('./capture-consent', () => ({
  hasCaptureConsent: vi.fn(),
  rememberCaptureConsent: vi.fn(),
}));

const draft: ProductDraft = {
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Recovery test product',
  images: [],
  videos: [],
  bulletPoints: [],
};

describe('first-use popup recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(hasCaptureConsent).mockResolvedValue(true);
    vi.mocked(rememberCaptureConsent).mockResolvedValue(undefined);
    vi.mocked(extensionRequest).mockImplementation(async (request): Promise<ExtensionResponse> => {
      if (request.type === 'PRODUCTSPY_CAPTURE') return { status: 'captured', draft };
      if (request.type === 'PRODUCTSPY_PENDING_COUNT') return { status: 'pending-count', count: 0 };
      return { status: 'bridge-state', paired: false };
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          Response.json({ ok: true, data: { mode: 'mock', version: '0.2.0' } }),
        ),
    );
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('explains double-click startup while disconnected and recovers without recapturing', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'));
    await act(() => root.render(createElement(App)));
    expect(container.textContent).toContain('双击便携包中的 ProductSpy.cmd');
    expect(container.textContent).toContain('商品可以先暂存于扩展');
    const recheck = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '重新检查连接',
    );
    await act(() => recheck?.click());
    expect(container.textContent).not.toContain('工作台未启动或暂时不可用');
    expect(container.textContent).toContain('未配置 AI Key：在工作台体验 Mock 演示分析');
    expect(
      vi
        .mocked(extensionRequest)
        .mock.calls.filter(([request]) => request.type === 'PRODUCTSPY_CAPTURE'),
    ).toHaveLength(1);
  });

  it('does not read an Amazon page before first consent and starts capture after accepting', async () => {
    vi.mocked(hasCaptureConsent).mockResolvedValue(false);
    await act(() => root.render(createElement(App)));
    expect(container.textContent).toContain('首次采集说明');
    expect(container.textContent).toContain('选定商品的文字资料才会发送至你配置的 AI 服务商');
    expect(
      vi
        .mocked(extensionRequest)
        .mock.calls.some(([request]) => request.type === 'PRODUCTSPY_CAPTURE'),
    ).toBe(false);
    const accept = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '同意并开始采集',
    );
    await act(() => accept?.click());
    expect(rememberCaptureConsent).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(extensionRequest)
        .mock.calls.filter(([request]) => request.type === 'PRODUCTSPY_CAPTURE'),
    ).toHaveLength(1);
    expect(container.textContent).toContain('Recovery test product');
  });

  it('keeps capture blocked when saving consent fails', async () => {
    vi.mocked(hasCaptureConsent).mockResolvedValue(false);
    vi.mocked(rememberCaptureConsent).mockRejectedValue(new Error('disk unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(() => root.render(createElement(App)));
    const accept = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '同意并开始采集',
    );
    await act(() => accept?.click());
    expect(container.textContent).toContain('尚未读取商品页面');
    expect(
      vi
        .mocked(extensionRequest)
        .mock.calls.some(([request]) => request.type === 'PRODUCTSPY_CAPTURE'),
    ).toBe(false);
  });

  it('lets a user retry an incomplete page capture and keeps the save action available after recovery', async () => {
    let captures = 0;
    vi.mocked(extensionRequest).mockImplementation(async (request): Promise<ExtensionResponse> => {
      if (request.type === 'PRODUCTSPY_CAPTURE') {
        captures += 1;
        return captures === 1
          ? { status: 'error', error: '商品页面尚未加载完成。' }
          : { status: 'captured', draft };
      }
      if (request.type === 'PRODUCTSPY_PENDING_COUNT') return { status: 'pending-count', count: 0 };
      return { status: 'bridge-state', paired: false };
    });
    await act(() => root.render(createElement(App)));
    expect(container.textContent).toContain('等待页面加载完成后');
    const retry = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('重新识别'),
    );
    await act(() => retry?.click());
    expect(container.textContent).toContain('Recovery test product');
    expect(container.querySelector('footer')?.textContent).toContain('保存到素材库');
    expect(container.textContent).not.toContain('暂时无法识别商品');
  });
});
