import { createHash } from 'node:crypto';
import { query } from './database';
import { appOrigin, extensionOriginPattern, sessionCookie } from './config';
import { AppError } from '../server/errors';
import { taskIdentity } from './task-identity';

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}
export interface AccountIdentity {
  user: AccountUser;
  tokenHash: string;
  kind: 'web' | 'extension';
}
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
export function requestToken(request: Request): string {
  const bearer = request.headers.get('authorization');
  if (bearer) return /^Bearer [a-f0-9]{64}$/.test(bearer) ? bearer.slice(7) : '';
  return (
    request.headers
      .get('cookie')
      ?.split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${sessionCookie}=`))
      ?.slice(sessionCookie.length + 1) ?? ''
  );
}
export async function rateLimit(key: string, limit: number, seconds = 60): Promise<void> {
  const now = new Date();
  const start = new Date(
    Math.floor(now.getTime() / (seconds * 1000)) * seconds * 1000,
  ).toISOString();
  const { rows } = await query<{ count: number }>(
    `INSERT INTO api_rate_limits(key,window_start,count) VALUES($1,$2,1)
     ON CONFLICT(key) DO UPDATE SET count=CASE WHEN api_rate_limits.window_start=$2 THEN api_rate_limits.count+1 ELSE 1 END,window_start=$2 RETURNING count`,
    [tokenHash(key), start],
  );
  if (Number(rows[0].count) > limit) {
    const error = new AppError(429, '请求过于频繁，请稍后重试');
    Object.assign(error, {
      retryAfterSeconds: seconds - (Math.floor(now.getTime() / 1000) % seconds),
    });
    throw error;
  }
}
export function assertCloudContext(
  request: Request,
  write = false,
  webOnly = false,
  unpairedExtension = false,
): void {
  const expected = new URL(appOrigin());
  const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
  if (host !== expected.host) throw new AppError(403, '请求主机无效');
  const origin = request.headers.get('origin');
  const extension = Boolean(origin && extensionOriginPattern.test(origin));
  if (origin && origin !== expected.origin && !extension)
    throw new AppError(403, '请求来源不受支持');
  if (webOnly && extension) throw new AppError(403, '请在 SaaS 工作台执行此操作');
  if (unpairedExtension && !extension) throw new AppError(403, '请从 Chrome 扩展授权连接');
  if (write) {
    if (!origin) throw new AppError(403, '写入请求缺少有效来源');
    if (request.headers.get('x-productspy-client') !== (extension ? 'extension' : 'web'))
      throw new AppError(403, '请求客户端与来源不匹配');
    if (
      request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
    )
      throw new AppError(415, '请求需要使用 JSON 格式');
  }
  if (!extension && request.headers.get('sec-fetch-site') === 'cross-site')
    throw new AppError(403, '不允许跨站请求');
}
export async function authenticateAccount(
  request: Request,
  webOnly = false,
): Promise<AccountIdentity> {
  const task = taskIdentity();
  if (task) return task;
  const token = requestToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError(401, '请登录 ProductSpy 账号');
  const hash = tokenHash(token);
  const { rows } = await query<{
    id: string;
    email: string;
    name: string;
    created_at: string | Date;
    kind: 'web' | 'extension';
    extension_origin: string | null;
  }>(
    `SELECT u.id,u.email,u.name,u.created_at,s.kind,s.extension_origin FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,
    [hash],
  );
  const row = rows[0];
  if (!row) throw new AppError(401, '登录已过期或已撤销，请重新登录');
  const origin = request.headers.get('origin');
  if (row.kind === 'extension') {
    if (
      webOnly ||
      origin !== row.extension_origin ||
      request.headers.get('x-productspy-client') !== 'extension'
    )
      throw new AppError(403, '此扩展令牌不允许该来源');
    const path = new URL(request.url).pathname;
    const allowed =
      (path === '/api/products' && request.method === 'POST') ||
      (path === '/api/bridge/status' && ['GET', 'OPTIONS'].includes(request.method)) ||
      (path === '/api/auth/logout' && request.method === 'POST');
    if (!allowed) throw new AppError(403, '扩展只可提交采集数据和管理当前连接');
  } else if ((origin && origin !== appOrigin()) || request.headers.has('authorization'))
    throw new AppError(403, '请使用 SaaS 浏览器会话');
  return {
    tokenHash: hash,
    kind: row.kind,
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
    },
  };
}
