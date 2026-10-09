// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from './ui';

describe('copy feedback and recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  const writeText = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeText.mockReset().mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  async function render(value = '第一行\n第二行') {
    await act(async () => root.render(createElement(CopyButton, { value })));
  }
  async function click() {
    await act(async () => container.querySelector('button')!.click());
  }
  it('copies complete multiline text and returns to its Chinese label', async () => {
    await render();
    await click();
    expect(writeText).toHaveBeenCalledWith('第一行\n第二行');
    expect(container.querySelector('button')!.textContent).toBe('已复制');
    expect(container.querySelector('button')!.type).toBe('button');
    await act(async () => vi.advanceTimersByTime(2300));
    expect(container.querySelector('button')!.textContent).toBe('复制');
  });
  it('preserves text in a selectable fallback when the clipboard is blocked', async () => {
    writeText.mockRejectedValue(new Error('Permission denied'));
    await render();
    await click();
    expect(container.querySelector('textarea')!.value).toBe('第一行\n第二行');
    expect(container.querySelector('[role="status"]')!.textContent).toContain('手动复制');
    expect(container.querySelector('textarea')!.readOnly).toBe(true);
  });
  it('does not claim new content was copied when a section changes', async () => {
    await render();
    await click();
    await render('更新后的内容');
    expect(container.querySelector('button')!.textContent).toBe('复制');
  });
});
