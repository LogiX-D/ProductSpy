// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksWorkspace } from './tasks-workspace';
import { getJobs } from '../lib/saas-api';
import type { AccountJobsPage } from '../lib/saas-types';

vi.mock('../lib/saas-api', () => ({ getJobs: vi.fn() }));
const result = (id: string, nextCursor?: string): AccountJobsPage => ({
  jobs: [
    {
      id,
      kind: 'analysis',
      status: 'succeeded',
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    },
  ],
  nextCursor: nextCursor ?? null,
});
function deferred() {
  let resolve!: (page: AccountJobsPage) => void;
  return {
    promise: new Promise<AccountJobsPage>((complete) => {
      resolve = complete;
    }),
    resolve: (value: AccountJobsPage) => resolve(value),
  };
}

describe('Task history page navigation and response ownership', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getJobs).mockReset();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((entry) => entry.textContent === label)!;
  const render = () => act(() => root.render(createElement(TasksWorkspace)));
  const click = (label: string) => act(() => button(label).click());

  it('navigates older pages, returns to the previous cursor and refreshes the current page', async () => {
    vi.mocked(getJobs).mockImplementation(async (options) =>
      options?.cursor ? result('older task') : result('latest task', 'next-page'),
    );
    await render();
    expect(container.textContent).toContain('latest task');
    expect(button('上一页').disabled).toBe(true);
    await click('下一页');
    expect(container.textContent).toContain('older task');
    expect(container.textContent).toContain('第 2 页');
    expect(button('下一页').disabled).toBe(true);
    expect(getJobs).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'next-page', limit: 50 }),
    );
    await click('刷新任务');
    expect(getJobs).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next-page' }));
    await click('上一页');
    expect(container.textContent).toContain('latest task');
    expect(container.textContent).toContain('第 1 页');
    expect(getJobs).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: undefined }));
  });

  it('ignores an old page background response that arrives after navigation', async () => {
    const background = deferred();
    vi.mocked(getJobs)
      .mockResolvedValueOnce(result('latest task', 'next-page'))
      .mockReturnValueOnce(background.promise)
      .mockResolvedValueOnce(result('older task'));
    await render();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    const oldSignal = vi.mocked(getJobs).mock.calls[1][0]?.signal;
    await click('下一页');
    expect(oldSignal?.aborted).toBe(true);
    await act(() => background.resolve(result('stale latest task', 'wrong-next-page')));
    expect(container.textContent).toContain('older task');
    expect(container.textContent).not.toContain('stale latest task');
    expect(button('下一页').disabled).toBe(true);
  });

  it('keeps the latest manual refresh when an older request resolves last', async () => {
    const earlier = deferred();
    vi.mocked(getJobs)
      .mockReturnValueOnce(earlier.promise)
      .mockResolvedValueOnce(result('new refresh'));
    await render();
    await click('刷新任务');
    expect(vi.mocked(getJobs).mock.calls[0][0]?.signal?.aborted).toBe(true);
    await act(() => earlier.resolve(result('stale refresh', 'stale-cursor')));
    expect(container.textContent).toContain('new refresh');
    expect(container.textContent).not.toContain('stale refresh');
    expect(button('下一页').disabled).toBe(true);
  });

  it('can return to the previous page after an older-page request fails', async () => {
    vi.mocked(getJobs)
      .mockResolvedValueOnce(result('latest task', 'next-page'))
      .mockRejectedValueOnce(new Error('Temporary history failure'))
      .mockResolvedValueOnce(result('latest task', 'next-page'));
    await render();
    await click('下一页');
    expect(container.textContent).toContain('Temporary history failure');
    expect(button('上一页').disabled).toBe(false);
    await click('上一页');
    expect(container.textContent).toContain('latest task');
    expect(container.textContent).not.toContain('Temporary history failure');
  });
});
