// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgePairing } from './bridge-pairing';
import { FirstUseGuide } from './first-use-guide';
import { webRequest } from '../lib/session';

vi.mock('../lib/session', () => ({ webRequest: vi.fn(), isLegacyMode: false }));

describe('SaaS extension connection interface', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  it('offers automatic account connection without fields or code generation', async () => {
    vi.mocked(webRequest).mockResolvedValue({ paired: false });
    await act(() => root.render(createElement(BridgePairing)));
    expect(container.textContent).toContain('扩展会自动连接当前浏览器已登录的 ProductSpy');
    expect(container.textContent).toContain('当前账号暂无有效的扩展连接');
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('扩展 ID');
    expect(container.textContent).not.toContain('配对码');
    expect(webRequest).toHaveBeenCalledTimes(1);
    expect(webRequest).toHaveBeenCalledWith('/api/bridge/status', {
      signal: expect.any(AbortSignal),
    });
    expect(container.querySelector('button')?.disabled).toBe(true);
  });

  it('revokes existing tokens and explains automatic connection and how to stop it', async () => {
    vi.mocked(webRequest).mockResolvedValue({ paired: true });
    await act(() => root.render(createElement(BridgePairing)));
    expect(container.textContent).toContain('当前账号有有效的扩展连接');
    await act(() => container.querySelector('button')?.click());
    expect(webRequest).toHaveBeenCalledWith('/api/bridge/revoke', { method: 'POST', body: '{}' });
    expect(container.textContent).toContain('当前账号暂无有效的扩展连接');
    expect(container.textContent).toContain('下次打开扩展会自动连接');
    expect(container.textContent).toContain('退出账号或退出网页登录');
    expect(container.querySelector('button')?.disabled).toBe(true);
  });

  it('does not claim a connection when status verification fails', async () => {
    vi.mocked(webRequest).mockRejectedValue(new Error('offline'));
    await act(() => root.render(createElement(BridgePairing)));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '无法读取扩展连接状态',
    );
    expect(container.textContent).toContain('连接状态暂不可用');
    expect(container.textContent).not.toContain('当前账号有有效的扩展连接');
    expect(container.querySelector('button')?.disabled).toBe(true);
  });

  it('explains install-and-use, webpage login, and restart recovery without manual pairing', async () => {
    await act(() => root.render(createElement(FirstUseGuide)));
    expect(container.textContent).toContain('安装后即可打开扩展使用');
    expect(container.textContent).toContain('完成网页登录后回到扩展继续');
    expect(container.textContent).toContain('重启浏览器后会重新连接已登录账号');
    expect(container.textContent).not.toContain('授权码');
    expect(container.textContent).not.toContain('扩展 ID');
  });
});
