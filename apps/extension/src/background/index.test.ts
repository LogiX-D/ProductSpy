import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connect, logout } = vi.hoisted(() => ({ connect: vi.fn(), logout: vi.fn() }));
vi.mock('../config', () => ({ LEGACY_MODE: false, APP_URL: 'http://127.0.0.1:3000' }));
vi.mock('./cloud-sync', () => ({
  CLOUD_SYNC_ALARM: 'test-cloud-alarm',
  CloudSyncController: class {
    connect = connect;
    logout = logout;
  },
}));

describe('trusted popup authentication messages (Chrome API mocks)', () => {
  const listen = vi.fn();
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  beforeEach(async () => {
    vi.resetModules();
    listen.mockReset();
    connect.mockReset().mockResolvedValue({ status: 'bridge-state', paired: true });
    logout.mockReset().mockResolvedValue({ status: 'bridge-state', paired: false });
    vi.stubGlobal('chrome', {
      storage: { local: { setAccessLevel: vi.fn(async () => undefined) } },
      runtime: {
        id: extensionId,
        getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
        onMessage: { addListener: listen },
        onStartup: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
      },
      alarms: { onAlarm: { addListener: vi.fn() } },
    });
    await import('./index');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('silently attempts startup connection without showing an auth window', () => {
    expect(connect).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('rejects connection and logout requests from page content scripts or another extension', () => {
    const listener = listen.mock.calls[0][0];
    const respond = vi.fn();
    connect.mockClear();
    for (const type of ['PRODUCTSPY_CONNECT', 'PRODUCTSPY_LOGOUT']) {
      expect(
        listener(
          { type },
          { id: extensionId, url: 'https://www.amazon.com/dp/B012345678' },
          respond,
        ),
      ).toBeUndefined();
      expect(
        listener({ type }, { id: 'another-extension', url: popupUrl }, respond),
      ).toBeUndefined();
    }
    expect(connect).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('allows only the trusted popup to explicitly resume automatic connection', async () => {
    const listener = listen.mock.calls[0][0];
    const respond = vi.fn();
    connect.mockClear();
    expect(
      listener({ type: 'PRODUCTSPY_CONNECT' }, { id: extensionId, url: popupUrl }, respond),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ status: 'bridge-state', paired: true }),
    );
    expect(connect).toHaveBeenCalledExactlyOnceWith();
  });

  it('rejects the legacy manual pairing message in SaaS mode', async () => {
    const { handleRequest } = await import('./index');
    expect(await handleRequest({ type: 'PRODUCTSPY_PAIR', code: 'a'.repeat(32) })).toMatchObject({
      status: 'error',
    });
  });
});
