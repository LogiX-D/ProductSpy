import { test as base, expect, type BrowserContextOptions } from '@playwright/test';

type SessionState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>;
/** Reuse one genuine, in-memory web session per test worker. Fresh page/preferences remain isolated.
 * Explicit anonymous contexts in the security tests never receive this state. This preserves the
 * production 30-new-sessions/minute protection rather than weakening it for a fast test suite. */
export const test = base.extend<object, { trustedSession: SessionState }>({
  trustedSession: [
    async ({ playwright }, provide) => {
      const request = await playwright.request.newContext();
      try {
        const response = await request.post('http://127.0.0.1:3000/api/session', {
          headers: {
            Origin: 'http://127.0.0.1:3000',
            'Content-Type': 'application/json',
            'X-ProductSpy-Client': 'web',
            'Sec-Fetch-Site': 'same-origin',
          },
          data: {},
        });
        expect(response.status()).toBe(200);
        const state = await request.storageState();
        expect(
          state.cookies.some((cookie) => cookie.name === 'productspy_session' && cookie.httpOnly),
        ).toBe(true);
        await provide(state);
      } finally {
        await request.dispose();
      }
    },
    { scope: 'worker' },
  ],
  storageState: async ({ trustedSession }, provide) => {
    await provide(trustedSession);
  },
});
export * from '@playwright/test';
