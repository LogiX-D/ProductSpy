// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgePairing, pairingSecondsLeft } from './bridge-pairing';
import { webRequest } from '../lib/session';

vi.mock('../lib/session', () => ({ webRequest: vi.fn(), isLegacyMode: true }));

describe('pairing code expiry and recovery', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T01:00:00Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  afterEach(async () => {
    if (root) await act(() => root?.unmount());
    root = undefined;
    container.remove();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('keeps the final partial second visible, then expires exactly at the deadline', () => {
    const expiry = '2026-10-08T01:02:00Z';
    expect(pairingSecondsLeft(expiry)).toBe(120);
    expect(pairingSecondsLeft(expiry, Date.parse(expiry) - 1)).toBe(1);
    expect(pairingSecondsLeft(expiry, Date.parse(expiry))).toBe(0);
    expect(pairingSecondsLeft(expiry, Date.parse(expiry) + 1000)).toBe(0);
  });

  it('does not show an invalid server expiry as a usable code', () => {
    expect(pairingSecondsLeft('invalid')).toBe(0);
  });

  it('removes an expired code, explains recovery and lets the user generate a fresh code', async () => {
    let codeCount = 0;
    vi.mocked(webRequest).mockImplementation(async (path) => {
      if (path === '/api/bridge/status') return { paired: false };
      codeCount += 1;
      return {
        code: String(codeCount).repeat(32),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      };
    });
    await act(() => {
      root = createRoot(container);
      root.render(createElement(BridgePairing));
    });
    const generateButton = () =>
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === '生成配对码',
      );
    await act(() => generateButton()?.click());
    expect(container.querySelector<HTMLInputElement>('#bridge-code')?.value).toBe('1'.repeat(32));
    expect(container.textContent).toContain('120 秒后过期');
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(container.querySelector('#bridge-code')).toBeNull();
    expect(container.textContent).toContain('配对码已过期');
    await act(() => generateButton()?.click());
    expect(container.querySelector<HTMLInputElement>('#bridge-code')?.value).toBe('2'.repeat(32));
    expect(container.textContent).not.toContain('配对码已过期');
  });
});
