import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PRODUCTSPY_EXTENSION_ID } from '@productspy/shared';
import { AppError } from '../server/errors';
import { readJsonBody } from '../server/http';
import { issueSession } from './accounts';
import { sessionCookie } from './config';
import { saasEnabled, withTenant } from './context';
import { dbTransaction, query } from './database';
import { assertCloudContext, rateLimit, tokenHash, type AccountUser } from './security';

function allowedExtensionOrigins(): Set<string> {
  const configured = process.env.PRODUCTSPY_EXTENSION_IDS;
  const ids =
    configured === undefined
      ? [PRODUCTSPY_EXTENSION_ID]
      : configured.split(',').map((id) => id.trim());
  if (!ids.length || ids.length > 20 || ids.some((id) => !/^[a-p]{32}$/.test(id)))
    throw new AppError(503, '扩展连接配置无效，请联系维护者');
  return new Set(ids.map((id) => `chrome-extension://${id}`));
}

function connectHeaders(request: Request): Headers {
  const headers = new Headers({ Vary: 'Origin', 'Cache-Control': 'no-store' });
  const origin = request.headers.get('origin');
  try {
    if (origin && allowedExtensionOrigins().has(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Credentials', 'true');
    }
  } catch {
    // Invalid configuration must never broaden credentialed CORS.
  }
  return headers;
}

function assertConnectRequest(request: Request, write: boolean): string {
  if (!saasEnabled()) throw new AppError(404, '当前模式不提供在线账号连接');
  const origin = request.headers.get('origin') ?? '';
  if (!allowedExtensionOrigins().has(origin))
    throw new AppError(403, '仅允许受信任的 ProductSpy 扩展连接当前账号');
  assertCloudContext(request, write, false, true);
  return origin;
}

function connectFailure(request: Request, error: unknown): Response {
  const known = error instanceof AppError;
  if (!known || error.status >= 500)
    console.error('[ProductSpy extension connection]', {
      status: known ? error.status : 500,
      type: error instanceof Error ? error.name : 'UnknownError',
    });
  const headers = connectHeaders(request);
  if (
    known &&
    error.status === 429 &&
    'retryAfterSeconds' in error &&
    typeof error.retryAfterSeconds === 'number'
  )
    headers.set(
      'Retry-After',
      String(Math.min(86400, Math.max(1, Math.ceil(error.retryAfterSeconds)))),
    );
  return Response.json(
    { ok: false, error: known ? error.message : '暂时无法连接账号，请检查网络后重试' },
    { status: known ? error.status : 500, headers },
  );
}

function webCookieToken(request: Request): string {
  // Ignore Authorization here: an extension bearer must never substitute for
  // the browser's independently authenticated current web account.
  const cookies = (request.headers.get('cookie') ?? '').split(';').map((item) => item.trim());
  const matches = cookies.filter((item) => item.startsWith(`${sessionCookie}=`));
  const token = matches.length === 1 ? matches[0].slice(sessionCookie.length + 1) : '';
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new AppError(401, '请先在当前浏览器登录 ProductSpy，登录后插件会自动连接');
  return token;
}

interface WebAccountRow {
  id: string;
  email: string;
  name: string;
  created_at: string | Date;
}

async function currentWebAccount(hash: string): Promise<WebAccountRow> {
  const { rows } = await query<WebAccountRow>(
    `SELECT u.id,u.email,u.name,u.created_at FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.kind='web' AND s.revoked_at IS NULL AND s.expires_at>now()`,
    [hash],
  );
  if (!rows[0]) throw new AppError(401, '网页登录已失效，请在当前浏览器重新登录 ProductSpy');
  return rows[0];
}

/** This is the only credentialed extension endpoint. It never exposes a web cookie. */
export async function connectExtension(request: Request): Promise<Response> {
  try {
    const origin = assertConnectRequest(request, true);
    const parsed = z
      .object({})
      .strict()
      .safeParse(await readJsonBody(request, 1024));
    if (!parsed.success) throw new AppError(400, '自动连接请求不接受账号或权限参数');
    const authorization = request.headers.get('authorization');
    if (authorization !== null && !/^Bearer [a-f0-9]{64}$/.test(authorization))
      throw new AppError(400, '扩展登录状态无效，请重试连接');
    const webHash = tokenHash(webCookieToken(request));
    const initial = await currentWebAccount(webHash);
    await rateLimit(`extension-connect:${initial.id}`, 120);
    const result = await withTenant(initial.id, async () => {
      // Password changes/logout use the same lock. Recheck after waiting so an
      // earlier Cookie read cannot resurrect a revoked browser session.
      const current = await currentWebAccount(webHash);
      if (current.id !== initial.id) throw new AppError(401, '当前账号已变化，请重新登录');
      return dbTransaction(async () => {
        const existingToken = authorization?.slice(7);
        let session: { token: string; expiresAt: string } | undefined;
        if (existingToken) {
          const existing = await query<{ expires_at: string | Date }>(
            `SELECT expires_at FROM sessions WHERE token_hash=$1 AND user_id=$2 AND kind='extension'
             AND extension_origin=$3 AND revoked_at IS NULL AND expires_at>now()`,
            [tokenHash(existingToken), current.id, origin],
          );
          if (existing.rows[0])
            session = {
              token: existingToken,
              expiresAt: new Date(existing.rows[0].expires_at).toISOString(),
            };
        }
        if (!session) {
          session = await issueSession(current.id, 'extension', origin);
          await query('INSERT INTO audit_events(id,user_id,action) VALUES($1,$2,$3)', [
            randomUUID(),
            current.id,
            'POST /api/bridge/connect',
          ]);
        }
        const user: AccountUser = {
          id: current.id,
          email: current.email,
          name: current.name,
          createdAt: new Date(current.created_at).toISOString(),
        };
        return { ...session, user };
      });
    });
    return Response.json({ ok: true, data: result }, { headers: connectHeaders(request) });
  } catch (error) {
    return connectFailure(request, error);
  }
}

export async function connectExtensionPreflight(request: Request): Promise<Response> {
  try {
    assertConnectRequest(request, false);
    if (request.headers.get('access-control-request-method')?.toUpperCase() !== 'POST')
      throw new AppError(405, '不支持此请求方法');
    const requested = (request.headers.get('access-control-request-headers') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (
      requested.some(
        (header) => !['content-type', 'x-productspy-client', 'authorization'].includes(header),
      )
    )
      throw new AppError(403, '不支持此请求头');
    const headers = connectHeaders(request);
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-ProductSpy-Client, Authorization');
    headers.set('Access-Control-Max-Age', '600');
    if (request.headers.get('access-control-request-private-network') === 'true')
      headers.set('Access-Control-Allow-Private-Network', 'true');
    return new Response(null, { status: 204, headers });
  } catch (error) {
    return connectFailure(request, error);
  }
}
