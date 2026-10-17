// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeProduct, type ProductDraft } from '@productspy/shared';
import { App } from './App';
import { extensionRequest, type ExtensionResponse } from '../background/messages';
import { hasCaptureConsent } from './capture-consent';
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
  title: 'Bottle',
  images: [],
  videos: [],
  bulletPoints: [],
};
const user = { id: 'a', email: 'a@example.test', name: 'A' };

describe('SaaS popup account flow (mocked background, not native browser acceptance)', () => {
  let root: Root;
  let container: HTMLDivElement;
  let signedIn: boolean;
  const openTab = vi.fn();
  function button(label: string) {
    const found = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === label,
    );
    expect(found).toBeDefined();
    return found!;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    signedIn = false;
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(hasCaptureConsent).mockResolvedValue(true);
    vi.stubGlobal('chrome', {
      runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
      tabs: { create: openTab },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, data: { version: '1.0.0', status: 'ok' } })),
    );
    vi.mocked(extensionRequest).mockImplementation(async (request): Promise<ExtensionResponse> => {
      switch (request.type) {
        case 'PRODUCTSPY_CAPTURE':
          return { status: 'captured', draft };
        case 'PRODUCTSPY_PENDING_COUNT':
          return { status: 'pending-count', count: 0, unassignedCount: 2 };
        case 'PRODUCTSPY_PAIR':
          signedIn = true;
          return { status: 'paired' };
        case 'PRODUCTSPY_LOGOUT':
          signedIn = false;
          return { status: 'bridge-state', paired: false };
        case 'PRODUCTSPY_SAVE':
          return { status: 'saved', product: mergeProduct(draft) };
        default:
          return { status: 'bridge-state', paired: signedIn, user: signedIn ? user : undefined };
      }
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('opens the web authorization URL with the real extension ID and explains unassigned records', async () => {
    await act(async () => root.render(createElement(App)));
    const link = Array.from(container.querySelectorAll('a')).find(
      (node) => node.textContent === '打开网页登录与授权',
    );
    expect(link?.href).toBe(
      'http://127.0.0.1:3000/settings?extensionId=abcdefghijklmnopabcdefghijklmnop',
    );
    expect(container.textContent).toContain('2 件旧版本或未登录记录没有账号归属');
    expect(container.textContent).not.toContain('ProductSpy.cmd');
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('a[href$="/privacy"]')).not.toBeNull();
  });

  it('exchanges a web authorization code, displays the account, and revokes on logout without claiming deletion', async () => {
    await act(async () => root.render(createElement(App)));
    const input = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'a'.repeat(32),
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(popupCopy.workspace.pair).click());
    expect(extensionRequest).toHaveBeenCalledWith({
      type: 'PRODUCTSPY_PAIR',
      code: 'a'.repeat(32),
    });
    expect(container.textContent).toContain(user.email);
    await act(async () => button(popupCopy.actions.save).click());
    expect(button(popupCopy.actions.openAnalysis)).toBeDefined();
    await act(async () => button('退出此账号').click());
    expect(extensionRequest).toHaveBeenCalledWith({ type: 'PRODUCTSPY_LOGOUT' });
    expect(container.textContent).not.toContain(user.email);
    expect(container.textContent).toContain('原账号的待同步记录仍保留');
    expect(button(popupCopy.actions.analyze)).toBeDefined();
  });

  it('keeps server queue errors visible and never labels a public health response as real AI validation', async () => {
    signedIn = true;
    const base = vi.mocked(extensionRequest).getMockImplementation()!;
    vi.mocked(extensionRequest).mockImplementation(async (request) =>
      request.type === 'PRODUCTSPY_PENDING_COUNT'
        ? { status: 'pending-count', count: 1, error: '额度不足，请到工作台查看' }
        : base(request),
    );
    await act(async () => root.render(createElement(App)));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('额度不足');
    expect(container.textContent).toContain('先保存商品，再到在线工作台发起分析');
    expect(button(popupCopy.actions.sync)).toBeDefined();
  });
});
