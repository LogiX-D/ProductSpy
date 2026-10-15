// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product, ProductDraft } from '@productspy/shared';
import { App } from './App';
import { extensionRequest, type ExtensionResponse } from '../background/messages';
import { hasCaptureConsent, rememberCaptureConsent } from './capture-consent';
import { popupCopy } from './copy';

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
const product: Product = {
  ...draft,
  id: 'amazon:B012345678',
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
};

function captureResponse(request: { type: string }): ExtensionResponse {
  if (request.type === 'PRODUCTSPY_CAPTURE') return { status: 'captured', draft };
  if (request.type === 'PRODUCTSPY_PENDING_COUNT') return { status: 'pending-count', count: 0 };
  return { status: 'bridge-state', paired: false };
}

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
      return captureResponse(request);
    });
    vi.stubGlobal('chrome', { tabs: { create: vi.fn().mockResolvedValue({ id: 1 }) } });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          Response.json({ ok: true, data: { mode: 'mock', version: '0.3.0' } }),
        ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  function button(label: string): HTMLButtonElement {
    const result = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
    expect(result, `Missing button: ${label}`).toBeDefined();
    return result!;
  }

  function expectShell() {
    // jsdom verifies the always-rendered structure; browser tests verify CSS dimensions.
    expect(container.querySelector('.popup-shell')).not.toBeNull();
    expect(container.querySelector('.popup-header')?.textContent).toContain(popupCopy.brand);
    expect(container.querySelector('main.popup-content')).not.toBeNull();
    expect(container.querySelector('footer.popup-footer')?.textContent).toContain(
      popupCopy.workspace.open,
    );
  }

  async function useActualConsentStorage(
    get: () => Promise<Record<string, unknown>>,
    set: () => Promise<void> = async () => {},
  ) {
    const actual = await vi.importActual<typeof import('./capture-consent')>('./capture-consent');
    vi.mocked(hasCaptureConsent).mockImplementation(actual.hasCaptureConsent);
    vi.mocked(rememberCaptureConsent).mockImplementation(actual.rememberCaptureConsent);
    vi.stubGlobal('chrome', {
      tabs: { create: vi.fn().mockResolvedValue({ id: 1 }) },
      storage: { local: { get, set } },
    });
    return actual;
  }

  it('renders the shell immediately while consent settings and background initialization are pending', async () => {
    vi.mocked(hasCaptureConsent).mockImplementation(() => new Promise<boolean>(() => {}));
    vi.mocked(extensionRequest).mockImplementation(() => new Promise<ExtensionResponse>(() => {}));
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
    await act(async () => root.render(createElement(App)));
    expectShell();
    expect(container.querySelector('main [role="status"]')?.textContent).toBe(
      popupCopy.consent.checking,
    );
    expect(extensionRequest).not.toHaveBeenCalledWith({ type: 'PRODUCTSPY_CAPTURE' });
  });

  it('renders the capture loading shell without waiting for pending counts or the workspace', async () => {
    vi.mocked(extensionRequest).mockImplementation(() => new Promise<ExtensionResponse>(() => {}));
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
    await act(async () => root.render(createElement(App)));
    expectShell();
    expect(container.querySelector('main [role="status"]')?.textContent).toContain(
      popupCopy.capture.loading,
    );
    expect(container.querySelector('details summary')?.textContent).toContain(
      popupCopy.workspace.checking,
    );
    expect(extensionRequest).toHaveBeenCalledWith({ type: 'PRODUCTSPY_CAPTURE' });
  });

  it('renders an actionable first-consent shell when storage rejects without reading the page', async () => {
    const failure = new Error('storage denied');
    const logged = vi.spyOn(console, 'error');
    await useActualConsentStorage(async () => {
      throw failure;
    });
    await act(async () => root.render(createElement(App)));
    expectShell();
    expect(container.querySelector('main [role="alert"]')?.textContent).toBe(
      popupCopy.consent.readError,
    );
    expect(button(popupCopy.consent.accept).disabled).toBe(false);
    expect(extensionRequest).not.toHaveBeenCalledWith({ type: 'PRODUCTSPY_CAPTURE' });
    expect(logged).toHaveBeenCalledWith('[ProductSpy] Consent settings unavailable', failure);
  });

  it('fails closed after consent-read timeout and ignores a late accepted record until explicit user action', async () => {
    let complete!: (value: Record<string, unknown>) => void;
    const get = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          complete = resolve;
        }),
    );
    const actual = await useActualConsentStorage(get);
    const logged = vi.spyOn(console, 'error');
    await act(async () => root.render(createElement(App)));
    expectShell();
    expect(container.textContent).toContain(popupCopy.consent.checking);
    await act(async () => vi.advanceTimersByTimeAsync(actual.CAPTURE_CONSENT_TIMEOUT_MS));
    expectShell();
    expect(container.textContent).toContain(popupCopy.consent.readError);
    await act(async () => complete({ [actual.CAPTURE_CONSENT_KEY]: { version: 1 } }));
    expect(container.textContent).toContain(popupCopy.consent.title);
    expect(extensionRequest).not.toHaveBeenCalledWith({ type: 'PRODUCTSPY_CAPTURE' });
    expect(get).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledOnce();
    await act(async () => button(popupCopy.consent.accept).click());
    expect(container.querySelector('h1')?.textContent).toBe(draft.title);
    expect(extensionRequest).toHaveBeenCalledWith({ type: 'PRODUCTSPY_CAPTURE' });
  });

  it('releases the consent button after a write timeout and requires a fresh user click even if the old write finishes', async () => {
    let complete!: () => void;
    const set = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const actual = await useActualConsentStorage(async () => ({}), set);
    const logged = vi.spyOn(console, 'error');
    await act(async () => root.render(createElement(App)));
    await act(async () => button(popupCopy.consent.accept).click());
    expectShell();
    expect(button(popupCopy.consent.saving).disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(actual.CAPTURE_CONSENT_TIMEOUT_MS));
    expectShell();
    expect(button(popupCopy.consent.accept).disabled).toBe(false);
    expect(container.textContent).toContain(popupCopy.consent.saveError);
    await act(async () => complete());
    expect(container.textContent).toContain(popupCopy.consent.title);
    expect(extensionRequest).not.toHaveBeenCalledWith({ type: 'PRODUCTSPY_CAPTURE' });
    expect(set).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledOnce();
    await act(async () => button(popupCopy.consent.accept).click());
    expect(set).toHaveBeenCalledTimes(2);
    expect(container.querySelector('h1')?.textContent).toBe(draft.title);
  });

  it('aborts consent initialization and removes timers on unmount without logging a storage failure', async () => {
    const actual = await useActualConsentStorage(() => new Promise<never>(() => {}));
    const logged = vi.spyOn(console, 'error');
    await act(async () => root.render(createElement(App)));
    const signal = vi.mocked(hasCaptureConsent).mock.calls[0][0];
    expect(signal?.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(actual.CAPTURE_CONSENT_TIMEOUT_MS));
    expect(logged).not.toHaveBeenCalled();
    expect(extensionRequest).not.toHaveBeenCalledWith({ type: 'PRODUCTSPY_CAPTURE' });
  });

  it('aborts a pending consent write on unmount and never captures after its late completion', async () => {
    let complete!: () => void;
    const set = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    await useActualConsentStorage(async () => ({}), set);
    const logged = vi.spyOn(console, 'error');
    await act(async () => root.render(createElement(App)));
    await act(async () => button(popupCopy.consent.accept).click());
    const signal = vi.mocked(rememberCaptureConsent).mock.calls[0][0];
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(2);
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => complete());
    expect(logged).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledOnce();
    expect(extensionRequest).not.toHaveBeenCalledWith({ type: 'PRODUCTSPY_CAPTURE' });
  });

  it('keeps the captured shell usable when workspace status times out', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.mocked(fetch).mockImplementation(
      (_input, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Workspace timed out', 'TimeoutError')),
            { once: true },
          );
        }),
    );
    await act(async () => root.render(createElement(App)));
    expectShell();
    expect(container.querySelector('details summary')?.textContent).toContain(
      popupCopy.workspace.checking,
    );
    await act(async () => deadline.abort());
    expectShell();
    expect(container.querySelector('h1')?.textContent).toBe(draft.title);
    expect(container.querySelector('details summary')?.textContent).toContain(
      popupCopy.workspace.offline,
    );
    expect(button(popupCopy.actions.save).disabled).toBe(false);
  });

  it('renders an unsupported page with recovery and workspace links inside the same shell', async () => {
    vi.mocked(extensionRequest).mockImplementation(async (request) =>
      request.type === 'PRODUCTSPY_CAPTURE' ? { status: 'unsupported' } : captureResponse(request),
    );
    await act(async () => root.render(createElement(App)));
    expectShell();
    expect(container.querySelector('h1')?.textContent).toBe(popupCopy.capture.unsupported);
    expect(button(popupCopy.capture.retry).disabled).toBe(false);
    expect(container.querySelector('footer a')?.getAttribute('href')).toBe('http://127.0.0.1:3000');
  });

  it('explains double-click startup while disconnected and recovers without recapturing', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'));
    await act(async () => root.render(createElement(App)));
    const connection = container.querySelector('details');
    expect(connection?.open).toBe(false);
    expect(connection?.querySelector('summary')?.textContent).toContain(
      popupCopy.workspace.offline,
    );
    expect(container.querySelector('h1')?.textContent).toBe(draft.title);
    expect(container.textContent).toContain('双击便携包中的 ProductSpy.cmd');
    expect(container.textContent).toContain('商品可以先暂存于扩展');
    await act(async () => connection?.querySelector('summary')?.click());
    expect(connection?.open).toBe(true);
    await act(async () => button(popupCopy.workspace.recheck).click());
    expect(container.textContent).not.toContain(popupCopy.workspace.offlineHint);
    expect(container.textContent).toContain(popupCopy.analysis.mock);
    expect(
      vi
        .mocked(extensionRequest)
        .mock.calls.filter(([request]) => request.type === 'PRODUCTSPY_CAPTURE'),
    ).toHaveLength(1);
  });

  it('does not read an Amazon page before first consent and starts capture after accepting', async () => {
    vi.mocked(hasCaptureConsent).mockResolvedValue(false);
    await act(async () => root.render(createElement(App)));
    expect(container.textContent).toContain(popupCopy.consent.title);
    expect(container.textContent).toContain('选定商品的文字资料才会发送至你配置的 AI 服务商');
    expect(
      vi
        .mocked(extensionRequest)
        .mock.calls.some(([request]) => request.type === 'PRODUCTSPY_CAPTURE'),
    ).toBe(false);
    await act(async () => button(popupCopy.consent.accept).click());
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
    await act(async () => root.render(createElement(App)));
    await act(async () => button(popupCopy.consent.accept).click());
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
    await act(async () => root.render(createElement(App)));
    expect(container.textContent).toContain('等待页面加载完成后');
    await act(async () => button(popupCopy.capture.retry).click());
    expect(container.textContent).toContain('Recovery test product');
    expect(container.querySelector('footer')?.textContent).toContain('保存到素材库');
    expect(container.textContent).not.toContain('暂时无法识别商品');
  });

  it('re-identifies a synthetic captured product with later videos only on user action and saves the updated draft', async () => {
    // Stub contract, not a real Amazon video-availability or timing acceptance result.
    const withVideos: ProductDraft = {
      ...draft,
      videos: [
        { url: 'https://m.media-amazon.com/images/S/synthetic-current.mp4' },
        { url: 'https://m.media-amazon.com/images/S/synthetic-current.webm' },
      ],
    };
    let captures = 0;
    vi.mocked(extensionRequest).mockImplementation(async (request): Promise<ExtensionResponse> => {
      if (request.type === 'PRODUCTSPY_CAPTURE') {
        captures += 1;
        return { status: 'captured', draft: captures === 1 ? draft : withVideos };
      }
      if (request.type === 'PRODUCTSPY_SAVE')
        return { status: 'saved', product: { ...product, ...withVideos } };
      return captureResponse(request);
    });
    const displayedVideoCount = () =>
      [...container.querySelectorAll('div')].find(
        (element) => element.firstElementChild?.textContent === popupCopy.product.videos,
      )?.lastElementChild?.textContent;

    await act(async () => root.render(createElement(App)));
    expect(container.querySelector('h1')?.textContent).toBe(draft.title);
    expect(container.textContent).toContain(draft.sourceId);
    expect(displayedVideoCount()).toBe('0');
    expect(button(popupCopy.actions.save).disabled).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(24000));
    expect(captures).toBe(1);
    expect(displayedVideoCount()).toBe('0');
    await act(async () => button(popupCopy.capture.retry).click());
    expect(captures).toBe(2);
    expect(displayedVideoCount()).toBe('2');
    expect(container.textContent).toContain(draft.sourceId);
    expect(container.querySelector('h1')?.textContent).toBe(draft.title);
    expect(button(popupCopy.actions.save).disabled).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(24000));
    expect(captures).toBe(2);
    await act(async () => button(popupCopy.actions.save).click());
    expect(extensionRequest).toHaveBeenCalledWith({ type: 'PRODUCTSPY_SAVE', draft: withVideos });
    expect(container.querySelector('footer [role="status"]')?.textContent).toBe(
      popupCopy.feedback.saved,
    );
    expect(captures).toBe(2);
  });

  it('confirms saving in the action bar and opens analysis without saving a second time', async () => {
    vi.mocked(extensionRequest).mockImplementation(async (request): Promise<ExtensionResponse> => {
      if (request.type === 'PRODUCTSPY_SAVE') return { status: 'saved', product };
      return captureResponse(request);
    });
    await act(async () => root.render(createElement(App)));
    await act(async () => button(popupCopy.actions.save).click());
    expect(container.querySelector('footer [role="status"]')?.textContent).toBe(
      popupCopy.feedback.saved,
    );
    expect(button(popupCopy.actions.update).disabled).toBe(false);
    await act(async () => button(popupCopy.actions.openAnalysis).click());
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:3000/products/amazon%3AB012345678?tab=analysis',
    });
    expect(container.querySelector('footer [role="status"]')?.textContent).toBe(
      popupCopy.feedback.analysisOpened,
    );
    expect(
      vi
        .mocked(extensionRequest)
        .mock.calls.filter(([request]) => request.type === 'PRODUCTSPY_SAVE'),
    ).toHaveLength(1);
  });

  it('keeps capture and queued sync errors distinct so either operation can be retried', async () => {
    vi.mocked(extensionRequest).mockImplementation(async (request): Promise<ExtensionResponse> => {
      if (request.type === 'PRODUCTSPY_CAPTURE')
        return { status: 'error', error: '商品页面尚未加载完成。' };
      if (request.type === 'PRODUCTSPY_PENDING_COUNT') return { status: 'pending-count', count: 1 };
      if (request.type === 'PRODUCTSPY_SYNC_PENDING')
        return { status: 'error', error: '工作台连接中断，暂存商品仍保留。' };
      return captureResponse(request);
    });
    await act(async () => root.render(createElement(App)));
    await act(async () => button(popupCopy.actions.sync).click());
    expect(container.querySelector('main [role="alert"]')?.textContent).toContain(
      '商品页面尚未加载完成',
    );
    expect(container.querySelector('footer [role="alert"]')?.textContent).toContain(
      '工作台连接中断',
    );
    expect(button(popupCopy.capture.retry).disabled).toBe(false);
    expect(button(popupCopy.actions.sync).disabled).toBe(false);
    expect(container.textContent).toContain(popupCopy.feedback.pendingCount(1));
  });

  it('retains the captured product after a save failure and makes retry explicit', async () => {
    let saves = 0;
    vi.mocked(extensionRequest).mockImplementation(async (request): Promise<ExtensionResponse> => {
      if (request.type === 'PRODUCTSPY_SAVE') {
        saves += 1;
        return saves === 1
          ? { status: 'error', error: '素材库暂时无法写入，请重试。' }
          : { status: 'saved', product };
      }
      return captureResponse(request);
    });
    await act(async () => root.render(createElement(App)));
    await act(async () => button(popupCopy.actions.save).click());
    expect(container.querySelector('footer [role="alert"]')?.textContent).toContain(
      '素材库暂时无法写入',
    );
    expect(container.querySelector('h1')?.textContent).toBe(draft.title);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    await act(async () => button(popupCopy.actions.retrySave).click());
    expect(container.querySelector('footer [role="alert"]')).toBeNull();
    expect(button(popupCopy.actions.update).disabled).toBe(false);
    expect(saves).toBe(2);
  });

  it('keeps queued products on sync failure and opens no analysis before a real save', async () => {
    let pendingCount = 0;
    let syncs = 0;
    vi.mocked(extensionRequest).mockImplementation(async (request): Promise<ExtensionResponse> => {
      if (request.type === 'PRODUCTSPY_PENDING_COUNT')
        return { status: 'pending-count', count: pendingCount };
      if (request.type === 'PRODUCTSPY_SAVE') {
        pendingCount = 1;
        return { status: 'pending', product, error: '工作台尚未连接。' };
      }
      if (request.type === 'PRODUCTSPY_SYNC_PENDING') {
        syncs += 1;
        if (syncs === 1) return { status: 'error', error: '同步暂时失败，请重试。' };
        pendingCount = 0;
        return { status: 'synced', count: 1 };
      }
      return captureResponse(request);
    });
    await act(async () => root.render(createElement(App)));
    await act(async () => button(popupCopy.actions.analyze).click());
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(container.querySelector('footer [role="status"]')?.textContent).toBe(
      popupCopy.feedback.pendingAnalysis,
    );
    expect(container.textContent).toContain(popupCopy.feedback.pendingCount(1));
    expect(button(popupCopy.actions.save).disabled).toBe(false);
    await act(async () => button(popupCopy.actions.sync).click());
    expect(container.textContent).toContain(popupCopy.feedback.pendingCount(1));
    expect(container.querySelector('footer [role="alert"]')?.textContent).toContain('同步暂时失败');
    await act(async () => button(popupCopy.actions.sync).click());
    expect(container.textContent).not.toContain(popupCopy.feedback.pendingCount(1));
    expect(container.querySelector('footer [role="status"]')?.textContent).toBe(
      popupCopy.feedback.synced(1),
    );
  });

  it('preserves a successful save when opening analysis fails and allows opening again', async () => {
    vi.mocked(extensionRequest).mockImplementation(async (request): Promise<ExtensionResponse> => {
      if (request.type === 'PRODUCTSPY_SAVE') return { status: 'saved', product };
      return captureResponse(request);
    });
    vi.mocked(chrome.tabs.create).mockRejectedValueOnce(new Error('无法打开分析页。'));
    await act(async () => root.render(createElement(App)));
    await act(async () => button(popupCopy.actions.analyze).click());
    expect(container.querySelector('footer [role="status"]')?.textContent).toBe(
      popupCopy.feedback.saved,
    );
    expect(container.querySelector('footer [role="alert"]')?.textContent).toContain(
      '无法打开分析页',
    );
    expect(button(popupCopy.actions.update).disabled).toBe(false);
    await act(async () => button(popupCopy.actions.openAnalysis).click());
    expect(container.querySelector('footer [role="alert"]')).toBeNull();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(extensionRequest)
        .mock.calls.filter(([request]) => request.type === 'PRODUCTSPY_SAVE'),
    ).toHaveLength(1);
  });
});
