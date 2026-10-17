import { draftSchema, productSchema, type Product, type ProductDraft } from '@productspy/shared';
import { APP_URL } from '../config';
import {
  cloudSession,
  beginCloudAuthChange,
  forgetCloudSession,
  rememberCloudSession,
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
  private async request(path: string, init: RequestInit, session?: CloudSession): Promise<unknown> {
    if (session && !(await stillCloudSession(session)))
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
        credentials: 'omit',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new CloudSyncError('暂时无法连接云端。商品已保留，网络恢复后自动重试。');
    }
    if (session && !(await stillCloudSession(session)))
      throw new CloudSyncError('账号已切换；原账号的待同步记录仍独立保留。', 409);
    if (response.status === 401 && session) {
      await forgetCloudSession(session.token);
      throw new CloudSyncError(
        '登录已过期或被撤销，请重新登录授权。待同步记录仍保留在原账号下。',
        401,
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (session && !(await stillCloudSession(session)))
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

  async pair(code: string): Promise<CloudSession> {
    const cleaned = code.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(cleaned)) throw new Error('请粘贴网页登录后生成的完整授权码。');
    const revision = beginCloudAuthChange();
    const result = await this.request('/api/bridge/pair', {
      method: 'POST',
      body: JSON.stringify({ code: cleaned }),
    });
    if (!validCloudSession(result)) throw new Error('云端返回了无效连接凭据，请重新授权。');
    await rememberCloudSession(result, revision);
    return result;
  }

  async status(): Promise<CloudSession | undefined> {
    const session = await cloudSession();
    if (!session) return undefined;
    const result = await this.request('/api/bridge/status', { method: 'GET' }, session);
    const status = result as { paired?: boolean; user?: { id?: string } } | undefined;
    if (status?.paired !== true || status.user?.id !== session.user.id) {
      await forgetCloudSession(session.token);
      throw new CloudSyncError('登录状态无效，请重新授权。', 401);
    }
    return session;
  }

  async logout(): Promise<void> {
    beginCloudAuthChange();
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
    const current = await cloudSession();
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
