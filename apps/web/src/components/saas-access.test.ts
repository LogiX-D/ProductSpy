// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@productspy/shared';
import { SaasAccess } from './saas-access';

const stubs = vi.hoisted(() => ({
  pathname: '/products',
  router: { replace: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => stubs.pathname,
  useRouter: () => stubs.router,
}));
vi.mock('../lib/session', () => ({
  ACCOUNT_CHANGED_EVENT: 'test-saas-account-changed',
  ACCOUNT_STORAGE_EVENT: 'test-saas-storage-changed',
  getAccountSession: () => undefined,
  clearAccountSession: vi.fn(),
  refreshAccountSession: stubs.refresh,
}));

describe('SaaS login redirect during asynchronous account invalidation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let rejectVerification: (error: unknown) => void;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.history.replaceState(null, '', '/products?search=speaker&sort=new');
    stubs.pathname = '/products';
    stubs.router.replace.mockReset().mockImplementation((target: string) => {
      window.history.replaceState(null, '', target);
    });
    stubs.refresh.mockReset().mockReturnValue(
      new Promise((_, reject) => {
        rejectVerification = reject;
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
    await act(async () => root.render(createElement(SaasAccess, { children: 'Protected data' })));
  }
  it('preserves the protected address once when logout and a pending 401 overlap a stale router pathname', async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(new Event('test-saas-account-changed'));
      window.dispatchEvent(new Event('test-saas-account-changed'));
      rejectVerification(new ApiRequestError('Signed out', 401));
    });
    expect(stubs.router.replace).toHaveBeenCalledExactlyOnceWith(
      '/login?next=%2Fproducts%3Fsearch%3Dspeaker%26sort%3Dnew',
    );
    expect(new URLSearchParams(window.location.search).get('next')).toBe(
      '/products?search=speaker&sort=new',
    );
  });
  it.each(['/login?next=%2Fproducts', '/register', '/privacy'])(
    'does not redirect a public page after the browser has navigated there: %s',
    async (path) => {
      await render();
      window.history.replaceState(null, '', path);
      await act(async () => rejectVerification(new ApiRequestError('Expired old request', 401)));
      expect(stubs.router.replace).not.toHaveBeenCalled();
      expect(window.location.pathname + window.location.search).toBe(path);
    },
  );
});
