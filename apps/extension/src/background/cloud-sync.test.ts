import { mergeProduct, type ProductDraft } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudSyncController, CLOUD_SYNC_ALARM } from './cloud-sync';
import { CloudCaptureQueue } from '../storage/CloudCaptureQueue';
import { CloudProductSyncAdapter } from '../storage/CloudProductSyncAdapter';
import {
  CLOUD_SESSION_KEY,
  cloudSession,
  rememberCloudSession,
  type CloudSession,
} from '../storage/cloud-session';

const draft: ProductDraft = {
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Bottle',
  images: [],
  videos: [],
  bulletPoints: [],
};
const sessionA: CloudSession = {
  token: 'a'.repeat(64),
  user: { id: 'user-a', email: 'a@example.test', name: 'A' },
  expiresAt: '2026-11-17T00:00:00.000Z',
};
const sessionB: CloudSession = {
  token: 'b'.repeat(64),
  user: { id: 'user-b', email: 'b@example.test', name: 'B' },
  expiresAt: sessionA.expiresAt,
};
const ok = (data: unknown) => Response.json({ ok: true, data });
function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('SaaS capture ownership and durable recovery (local HTTP mocks)', () => {
  let records: Record<string, unknown>;
  const fetch = vi.fn<typeof globalThis.fetch>();
  const createAlarm = vi.fn();
  const clearAlarm = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-17T00:00:00.000Z');
    records = { [CLOUD_SESSION_KEY]: structuredClone(sessionA) };
    fetch.mockReset();
    createAlarm.mockReset();
    clearAlarm.mockReset();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => structuredClone({ [key]: records[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            records = { ...records, ...structuredClone(value) };
          }),
          remove: vi.fn(async (key: string) => {
            delete records[key];
          }),
        },
      },
      alarms: { create: createAlarm, clear: clearAlarm },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('writes the queue before upload and supplies a stable idempotency key on timeout recovery', async () => {
    const controller = new CloudSyncController();
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    expect((await controller.save(draft)).status).toBe('pending');
    const [capture] = await new CloudCaptureQueue(sessionA.user.id).pending();
    const first = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(first.get('Idempotency-Key')).toBe(capture.captureId);
    expect(first.get('Authorization')).toBe(`Bearer ${sessionA.token}`);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(draft);
    expect(fetch.mock.calls[0][1]?.credentials).toBe('omit');
    expect(createAlarm).toHaveBeenCalledWith(
      CLOUD_SYNC_ALARM,
      expect.objectContaining({ when: expect.any(Number) }),
    );
    fetch.mockResolvedValueOnce(ok(mergeProduct(draft)));
    vi.setSystemTime(capture.nextAttemptAt + 1);
    expect(await new CloudSyncController().syncPending(false)).toBe(1);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Idempotency-Key')).toBe(
      capture.captureId,
    );
    expect(await new CloudCaptureQueue(sessionA.user.id).pending()).toEqual([]);
  });

  it('keeps account queues isolated across sign-in changes and never adopts legacy or unassigned captures', async () => {
    const own = new CloudCaptureQueue(sessionA.user.id);
    await own.enqueue(draft);
    await new CloudCaptureQueue().enqueue({ ...draft, title: 'Unassigned' });
    records['productspy.local.v1'] = { pending: { legacy: draft } };
    await rememberCloudSession(sessionB);
    const controller = new CloudSyncController();
    expect(await controller.count()).toMatchObject({ count: 0, unassignedCount: 2 });
    expect(await controller.syncPending(false)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(await own.pending()).toHaveLength(1);
    await rememberCloudSession(sessionA);
    fetch.mockResolvedValueOnce(ok(mergeProduct(draft)));
    expect(await controller.syncPending(true)).toBe(1);
    expect(await own.pending()).toHaveLength(0);
    expect(await new CloudCaptureQueue().pending()).toHaveLength(1);
  });

  it('does not clear a newer same-ASIN capture when an older upload finishes', async () => {
    let finish!: (response: Response) => void;
    const started = deferredSignal();
    fetch.mockImplementationOnce(async () => {
      started.resolve();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const controller = new CloudSyncController();
    const saved = controller.save(draft);
    await started.promise;
    const queue = new CloudCaptureQueue(sessionA.user.id);
    const newer = await queue.enqueue({ ...draft, title: 'New title' });
    finish(ok(mergeProduct(draft)));
    expect((await saved).status).toBe('pending');
    expect(await queue.pending()).toEqual([newer.capture]);
  });

  it.each([200, 401])(
    'an in-flight %s from account A cannot acknowledge into or sign out account B',
    async (status) => {
      let finish!: (response: Response) => void;
      const started = deferredSignal();
      fetch.mockImplementationOnce(async () => {
        started.resolve();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const controller = new CloudSyncController();
      const result = controller.save(draft);
      await started.promise;
      await rememberCloudSession(sessionB);
      finish(
        status === 200
          ? ok(mergeProduct(draft))
          : Response.json({ ok: false, error: 'revoked' }, { status }),
      );
      expect((await result).status).toBe('pending');
      expect((await cloudSession())?.token).toBe(sessionB.token);
      expect(await new CloudCaptureQueue(sessionB.user.id).pending()).toEqual([]);
      expect(await new CloudCaptureQueue(sessionA.user.id).pending()).toHaveLength(1);
      expect(await controller.count()).toMatchObject({ count: 0 });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('pauses revoked credentials without deleting the original account queue', async () => {
    fetch.mockResolvedValueOnce(Response.json({ ok: false, error: 'revoked' }, { status: 401 }));
    const controller = new CloudSyncController();
    expect(await controller.save(draft)).toMatchObject({
      status: 'pending',
      error: expect.stringContaining('重新登录'),
    });
    expect(await cloudSession()).toBeUndefined();
    expect(await new CloudCaptureQueue(sessionA.user.id).pending()).toHaveLength(1);
    await expect(controller.syncPending(false)).rejects.toThrow('重新登录');
    expect(fetch).toHaveBeenCalledOnce();
    expect(clearAlarm).toHaveBeenCalledWith(CLOUD_SYNC_ALARM);
  });

  it('honors Retry-After and resumes after the deadline with the same capture id', async () => {
    fetch.mockResolvedValueOnce(
      Response.json(
        { ok: false, error: 'rate limited' },
        { status: 429, headers: { 'Retry-After': '120' } },
      ),
    );
    const controller = new CloudSyncController();
    await controller.save(draft);
    const [capture] = await new CloudCaptureQueue(sessionA.user.id).pending();
    expect(capture.nextAttemptAt).toBe(Date.now() + 120_000);
    expect(await controller.syncPending(false)).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    vi.setSystemTime(capture.nextAttemptAt + 1);
    fetch.mockResolvedValueOnce(ok(mergeProduct(draft)));
    expect(await controller.syncPending(false)).toBe(1);
  });

  it('applies rate-limit cooldown to new captures and explicit retries, across restarts', async () => {
    fetch.mockResolvedValueOnce(
      Response.json(
        { ok: false, error: 'rate limited' },
        { status: 429, headers: { 'Retry-After': '120' } },
      ),
    );
    await new CloudSyncController().save(draft);
    const controller = new CloudSyncController();
    expect(
      (
        await controller.save({
          ...draft,
          sourceId: 'B098765432',
          url: 'https://www.amazon.com/dp/B098765432',
        })
      ).status,
    ).toBe('pending');
    expect(await controller.syncPending(true)).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('serializes same-product uploads so an older request cannot finish after a newer one', async () => {
    let finish!: (response: Response) => void;
    const started = deferredSignal();
    fetch.mockImplementationOnce(async () => {
      started.resolve();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const controller = new CloudSyncController();
    const old = controller.save(draft);
    await started.promise;
    const newer = { ...draft, title: 'New revision' };
    fetch.mockResolvedValueOnce(ok(mergeProduct(newer)));
    const recent = controller.save(newer);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    finish(ok(mergeProduct(draft)));
    await old;
    expect(await recent).toMatchObject({ status: 'saved', product: { title: 'New revision' } });
    expect(await new CloudCaptureQueue(sessionA.user.id).pending()).toEqual([]);
  });

  it('does not restore a pending sign-in after the user explicitly logs out', async () => {
    delete records[CLOUD_SESSION_KEY];
    let finish!: (response: Response) => void;
    const started = deferredSignal();
    fetch.mockImplementationOnce(async () => {
      started.resolve();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const adapter = new CloudProductSyncAdapter();
    const pairing = adapter.pair('d'.repeat(32));
    await started.promise;
    await adapter.logout();
    finish(ok(sessionA));
    await expect(pairing).rejects.toThrow('取消');
    expect(await cloudSession()).toBeUndefined();
  });

  it('refuses a mismatched product acknowledgement without removing the capture', async () => {
    const queue = new CloudCaptureQueue(sessionA.user.id);
    const { capture } = await queue.enqueue(draft);
    await expect(
      queue.acknowledge(
        capture,
        mergeProduct({
          ...draft,
          sourceId: 'B098765432',
          url: 'https://www.amazon.com/dp/B098765432',
        }),
      ),
    ).rejects.toThrow('不匹配');
    expect(await queue.pending()).toHaveLength(1);
  });

  it('keeps permanent 4xx errors visible without infinite background resends and allows explicit recovery', async () => {
    fetch.mockResolvedValueOnce(
      Response.json({ ok: false, error: 'Capture rejected' }, { status: 422 }),
    );
    const controller = new CloudSyncController();
    await controller.save(draft);
    expect(await controller.count()).toMatchObject({ count: 1, error: 'Capture rejected' });
    expect(await controller.syncPending(false)).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockResolvedValueOnce(ok(mergeProduct(draft)));
    expect(await controller.syncPending(true)).toBe(1);
  });

  it('caps automatic attempts durably across worker restarts', async () => {
    fetch.mockRejectedValue(new TypeError('offline'));
    await new CloudSyncController().save(draft);
    for (let attempt = 1; attempt < 8; attempt += 1) {
      const [capture] = await new CloudCaptureQueue(sessionA.user.id).pending();
      vi.setSystemTime(capture.nextAttemptAt + 1);
      await new CloudSyncController().syncPending(false);
    }
    expect((await new CloudCaptureQueue(sessionA.user.id).pending())[0]).toMatchObject({
      attempts: 8,
      blocked: true,
    });
    expect(await new CloudSyncController().syncPending(false)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it('revokes on logout, retains queues, and rejects old credentials after expiry', async () => {
    await new CloudCaptureQueue(sessionA.user.id).enqueue(draft);
    fetch.mockResolvedValueOnce(ok({ loggedOut: true }));
    await new CloudSyncController().logout();
    expect(fetch.mock.calls[0][0]).toContain('/api/auth/logout');
    expect(await cloudSession()).toBeUndefined();
    expect(await new CloudCaptureQueue(sessionA.user.id).pending()).toHaveLength(1);
    await rememberCloudSession(sessionA);
    vi.setSystemTime('2026-12-01T00:00:00.000Z');
    await expect(
      new CloudProductSyncAdapter().save(draft, crypto.randomUUID(), sessionA),
    ).rejects.toThrow('原账号');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects invalid pairing data without replacing an existing account', async () => {
    fetch.mockResolvedValueOnce(
      ok({ token: 'c'.repeat(64), user: sessionB.user, expiresAt: 'invalid' }),
    );
    await expect(new CloudProductSyncAdapter().pair('d'.repeat(32))).rejects.toThrow('无效');
    expect(await cloudSession()).toEqual(sessionA);
  });

  it('validates server account identity rather than trusting a locally stored user label', async () => {
    fetch.mockResolvedValueOnce(ok({ paired: true, user: sessionB.user }));
    await expect(new CloudProductSyncAdapter().status()).rejects.toThrow('登录状态无效');
  });
});
