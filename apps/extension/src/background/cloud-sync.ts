import { errorMessage, type ProductDraft } from '@productspy/shared';
import { CloudCaptureQueue } from '../storage/CloudCaptureQueue';
import { CloudProductSyncAdapter, CloudSyncError } from '../storage/CloudProductSyncAdapter';
import {
  cloudAutoConnectPaused,
  cloudSession,
  stillCloudSession,
  type CloudSession,
} from '../storage/cloud-session';
import type { ExtensionResponse, SaveResult } from './messages';

export const CLOUD_SYNC_ALARM = 'productspy.cloud-sync.v1';

export class CloudSyncController {
  private syncing?: Promise<number>;
  private scheduling: Promise<void> = Promise.resolve();
  private uploads: Promise<unknown> = Promise.resolve();
  constructor(private readonly remote = new CloudProductSyncAdapter()) {}

  schedule(): Promise<void> {
    const scheduled = this.scheduling.then(() => this.scheduleCurrent());
    this.scheduling = scheduled.catch(() => undefined);
    return scheduled;
  }

  private async scheduleCurrent(): Promise<void> {
    const session = await cloudSession();
    if (!session || (await cloudAutoConnectPaused())) {
      await chrome.alarms.clear(CLOUD_SYNC_ALARM);
      return;
    }
    const pending = (await new CloudCaptureQueue(session.user.id).pending()).filter(
      (item) => !item.blocked,
    );
    if (!pending.length) {
      await chrome.alarms.clear(CLOUD_SYNC_ALARM);
      return;
    }
    await chrome.alarms.create(CLOUD_SYNC_ALARM, {
      when: Math.max(Date.now() + 30_000, Math.min(...pending.map((item) => item.nextAttemptAt))),
    });
  }

  private async verifiedSession(explicit = false): Promise<CloudSession | undefined> {
    const verification = explicit ? this.remote.connect(true) : this.remote.status();
    void verification.catch(() => undefined);
    const previous = await cloudSession();
    const session = await verification;
    if (session && (explicit || previous?.token !== session.token))
      await new CloudCaptureQueue(session.user.id).retryBlocked();
    return session;
  }

  async connect(explicit = true): Promise<ExtensionResponse> {
    const session = await this.verifiedSession(explicit);
    await this.schedule();
    if (session) void this.syncPending(false).catch(() => undefined);
    return {
      status: 'bridge-state',
      paired: Boolean(session),
      user: session?.user,
      expiresAt: session?.expiresAt,
    };
  }

  async logout(): Promise<ExtensionResponse> {
    await this.remote.logout();
    await this.schedule();
    return { status: 'bridge-state', paired: false };
  }

  async state(): Promise<ExtensionResponse> {
    try {
      const session = await this.verifiedSession();
      await this.schedule();
      if (
        session &&
        (await new CloudCaptureQueue(session.user.id).pending()).some(
          (capture) => !capture.blocked && capture.nextAttemptAt <= Date.now(),
        )
      )
        void this.syncPending(false).catch(() => undefined);
      return {
        status: 'bridge-state',
        paired: Boolean(session),
        user: session?.user,
        expiresAt: session?.expiresAt,
      };
    } catch (error) {
      return {
        status: 'bridge-state',
        paired: false,
        error: errorMessage(error),
      };
    }
  }

  async count(): Promise<ExtensionResponse> {
    let session: CloudSession | undefined;
    let connectionError: string | undefined;
    try {
      session = await this.verifiedSession();
    } catch (error) {
      connectionError = errorMessage(error);
    }
    const pending = session ? await new CloudCaptureQueue(session.user.id).pending() : [];
    const unassigned = await new CloudCaptureQueue().pending();
    // Legacy records have no trustworthy account owner and are never adopted automatically.
    const legacy = (await chrome.storage.local.get('productspy.local.v1'))[
      'productspy.local.v1'
    ] as { pending?: Record<string, unknown> } | undefined;
    return {
      status: 'pending-count',
      count: pending.length,
      userId: session?.user.id,
      unassignedCount: unassigned.length + Object.keys(legacy?.pending ?? {}).length,
      error: connectionError ?? pending.find((capture) => capture.error)?.error,
    };
  }

  async save(draft: ProductDraft): Promise<SaveResult> {
    let session: CloudSession | undefined;
    try {
      session = await this.verifiedSession();
    } catch (error) {
      // An offline capture may stay with the previously known account, but a
      // cached bearer alone is never permission to upload or display its queue.
      const known = (await cloudAutoConnectPaused()) ? undefined : await cloudSession();
      const queue = new CloudCaptureQueue(known?.user.id);
      const { capture, product } = await queue.enqueue(draft);
      await this.recordFailure(queue, capture, error);
      await this.schedule();
      return { status: 'pending', product, error: errorMessage(error) };
    }
    const queue = new CloudCaptureQueue(session?.user.id);
    const { capture, product: local } = await queue.enqueue(draft);
    if (!session)
      return {
        status: 'pending',
        product: local,
        error: '请先登录 SaaS 网页后重新打开插件。此未归属记录不会自动上传；登录后请重新点击保存。',
      };
    if (capture.nextAttemptAt > Date.now()) {
      await this.schedule();
      return {
        status: 'pending',
        product: local,
        error: '云端暂时限制请求，已遵守 Retry-After，稍后自动同步。',
      };
    }
    try {
      const { product, acknowledged } = await this.upload(queue, capture, session);
      if (!acknowledged)
        return {
          status: 'pending',
          product: local,
          error: '商品在上传期间已更新，新版本继续等待同步。',
        };
      return { status: 'saved', product };
    } catch (error) {
      return { status: 'pending', product: local, error: errorMessage(error) };
    } finally {
      await this.schedule();
    }
  }

  private upload(
    queue: CloudCaptureQueue,
    capture: Awaited<ReturnType<CloudCaptureQueue['pending']>>[number],
    session: CloudSession,
  ) {
    const uploaded = this.uploads.then(async () => {
      const current = (await queue.pending()).find((item) => item.captureId === capture.captureId);
      if (!current) throw new CloudSyncError('此采集已被更新版本替代，无需重复上传。', 409);
      if (current.nextAttemptAt > Date.now())
        throw new CloudSyncError(
          '云端暂时限制请求，稍后自动同步。',
          429,
          current.nextAttemptAt - Date.now(),
        );
      try {
        const product = await this.remote.save(capture.draft, capture.captureId, session);
        if (!(await stillCloudSession(session)))
          throw new CloudSyncError('账号已切换，请在当前账号重新保存。', 409);
        return { product, acknowledged: await queue.acknowledge(capture, product) };
      } catch (error) {
        await this.recordFailure(queue, capture, error);
        throw error;
      }
    });
    this.uploads = uploaded.catch(() => undefined);
    return uploaded;
  }

  private async recordFailure(
    queue: CloudCaptureQueue,
    capture: Awaited<ReturnType<CloudCaptureQueue['pending']>>[number],
    error: unknown,
  ) {
    await queue.failed(
      capture,
      errorMessage(error),
      error instanceof CloudSyncError && error.retryable,
      error instanceof CloudSyncError ? error.retryAfterMs : undefined,
      error instanceof CloudSyncError && error.status === 429,
    );
  }

  async syncPending(manual: boolean): Promise<number> {
    // One service-worker drain at a time, including popup saves/alarms/login recovery.
    if (this.syncing) return this.syncing;
    this.syncing = this.drain(manual);
    try {
      return await this.syncing;
    } finally {
      this.syncing = undefined;
      await this.schedule();
    }
  }

  private async drain(manual: boolean): Promise<number> {
    let session: CloudSession | undefined;
    try {
      session = await this.verifiedSession();
    } catch (error) {
      const known = (await cloudAutoConnectPaused()) ? undefined : await cloudSession();
      if (known) {
        const queue = new CloudCaptureQueue(known.user.id);
        const capture = (await queue.pending()).find(
          (item) => !item.blocked && item.nextAttemptAt <= Date.now(),
        );
        if (capture) await this.recordFailure(queue, capture, error);
      }
      if (manual) throw error;
      return 0;
    }
    if (!session) throw new Error('请先重新登录 SaaS 网页；各账号的待同步记录会独立保留。');
    const queue = new CloudCaptureQueue(session.user.id);
    if (manual) await queue.retryBlocked();
    let count = 0;
    for (const capture of await queue.pending()) {
      if (capture.blocked || capture.nextAttemptAt > Date.now()) continue;
      if (!(await stillCloudSession(session))) break;
      try {
        const { acknowledged } = await this.upload(queue, capture, session);
        if (acknowledged) count += 1;
      } catch (error) {
        // Stop at connectivity/rate/auth errors; permanent item errors do not poison other items.
        if (!(error instanceof CloudSyncError) || error.status === 401 || error.retryable) {
          if (manual) throw error;
          break;
        }
      }
    }
    return count;
  }
}
