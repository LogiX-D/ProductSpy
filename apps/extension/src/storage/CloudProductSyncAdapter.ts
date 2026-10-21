import { draftSchema, productSchema, type Product, type ProductDraft } from '@productspy/shared';
import { APP_URL } from '../config';
import {
  cloudSession,
  cloudAutoConnectPaused,
  beginCloudAuthChange,
  currentCloudAuthRevision,
  forgetCloudSession,
  isCurrentCloudAuthChange,
  rememberCloudSession,
  setCloudAutoConnectPaused,
  stillCloudSession,
  validCloudSession,
  type CloudSession,
} from './cloud-session';

export class CloudSyncError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'CloudSyncError';
  }
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(1000, milliseconds) : undefined;
}

export class CloudProductSyncAdapter {
  private connecting?: Promise<CloudSession | undefined>;

  private async request(path: string, init: RequestInit, session?: CloudSession): Promise<unknown> {
    const connecting = path === '/api/bridge/connect';
    const loggingOut = path === '/api/auth/logout';
    if (session && !connecting && !(await stillCloudSession(session, loggingOut)))
      throw new CloudSyncError('账号已切换，请在当前账号下重新保存。', 409);
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('X-ProductSpy-Client', 'extension');
    if (session) headers.set('Authorization', `Bearer ${session.token}`);
    let response: Response;
    try {
      response = await fetch(`${APP_URL}${path}`, {
        ...init,
        headers,
        credentials: connecting ? 'include' : 'omit',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new CloudSyncError('暂时无法连接云端。商品已保留，网络恢复后自动重试。');
    }
    if (session && !connecting && !(await stillCloudSession(session, loggingOut)))
      throw new CloudSyncError('账号已切换；原账号的待同步记录仍独立保留。', 409);
    if (response.status === 401 && session && !connecting) {
      await forgetCloudSession(session.token);
      throw new CloudSyncError(
        '登录已过期或被撤销，请重新登录授权。待同步记录仍保留在原账号下。',
        401,
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (session && !connecting && !(await stillCloudSession(session, loggingOut)))
      throw new CloudSyncError('账号已切换，原账号的请求结果已忽略。', 409);
    const envelope = body as { ok?: boolean; data?: unknown; error?: string } | undefined;
    if (!response.ok || envelope?.ok !== true) {
      throw new CloudSyncError(
        typeof envelope?.error === 'string' ? envelope.error : `云端请求失败 (${response.status})`,
        response.ok ? 502 : response.status,
        retryAfter(response),
      );
    }
    return envelope.data;
  }

  connect(explicit = false): Promise<CloudSession | undefined> {
    if (!explicit && this.connecting) return this.connecting;
    // Background checks must never supersede a user's explicit logout/resume.
    const revision = explicit ? beginCloudAuthChange() : currentCloudAuthRevision();
    const pending = this.refreshConnection(explicit, revision);
    this.connecting = pending;
    const clear = () => {
      if (this.connecting === pending) this.connecting = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async refreshConnection(
    explicit: boolean,
    revision: number,
  ): Promise<CloudSession | undefined> {
    if (explicit) await setCloudAutoConnectPaused(false, revision);
    if (await cloudAutoConnectPaused()) return undefined;
    const previous = await cloudSession();
    if (!isCurrentCloudAuthChange(revision))
      throw new CloudSyncError('登录操作已被更新的登录或退出操作取消，请重试。', 409);
    let result: unknown;
    try {
      // Only this endpoint receives the HttpOnly website cookie. The server
      // derives the account from that cookie and may reuse the optional bearer.
      result = await this.request('/api/bridge/connect', { method: 'POST', body: '{}' }, previous);
    } catch (error) {
      if (!isCurrentCloudAuthChange(revision))
        throw new CloudSyncError('登录操作已被更新的登录或退出操作取消，请重试。', 409);
      if (!(error instanceof CloudSyncError) || error.status !== 401) throw error;
      if (previous) await forgetCloudSession(previous.token);
      return undefined;
    }
    if (!validCloudSession(result)) throw new Error('云端返回了无效连接凭据，请重新登录网页。');
    await rememberCloudSession(result, revision);
    return result;
  }

  status(): Promise<CloudSession | undefined> {
    return this.connect();
  }

  async logout(): Promise<void> {
    const revision = beginCloudAuthChange();
    await setCloudAutoConnectPaused(true, revision);
    const session = await cloudSession(true);
    if (!session) return;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await forgetCloudSession(session.token);
      return;
    }
    // Revocation must succeed (or already be expired/revoked) before discarding the credential.
    try {
      await this.request('/api/auth/logout', { method: 'POST' }, session);
    } catch (error) {
      if (!(error instanceof CloudSyncError) || error.status !== 401) throw error;
    }
    await forgetCloudSession(session.token);
  }

  async save(draft: ProductDraft, captureId: string, expected: CloudSession): Promise<Product> {
    const validated = draftSchema.parse(draft);
    const current = await this.status();
    if (!current || current.token !== expected.token || current.user.id !== expected.user.id)
      throw new CloudSyncError('请登录原账号后重试，商品不会上传至其他账号。', 401);
    const result = await this.request(
      '/api/products',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': captureId },
        body: JSON.stringify(validated),
      },
      current,
    );
    const parsed = productSchema.safeParse(result);
    if (!parsed.success)
      throw new CloudSyncError('云端返回的商品格式不正确，待同步记录已保留。', 502);
    return parsed.data;
  }
}
