import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { AppError } from '../server/errors';
import { withDatabaseTenant } from './database';

const globals = globalThis as typeof globalThis & {
  __productspyTenant?: AsyncLocalStorage<string>;
  __productspyTenantQueues?: Map<string, Promise<unknown>>;
};
const scope = (globals.__productspyTenant ??= new AsyncLocalStorage<string>());
const queues = (globals.__productspyTenantQueues ??= new Map<string, Promise<unknown>>());
export function saasEnabled(): boolean {
  return process.env.PRODUCTSPY_MODE !== 'legacy';
}
export function currentUserId(): string {
  const userId = scope.getStore();
  if (!userId) throw new AppError(401, '请先登录 ProductSpy 账号');
  return userId;
}
/** An opaque registry identifier only. SaaS storage must never create this directory. */
export function tenantDirectory(): string {
  const database =
    process.env.DATABASE_URL ??
    `${process.env.PRODUCTSPY_DB_DRIVER}:${process.env.PRODUCTSPY_PGLITE_DIR}`;
  const key = createHash('sha256').update(`${database}:${currentUserId()}`).digest('hex');
  return resolve(process.cwd(), '.saas-scope', key);
}
export async function withTenant<T>(userId: string, operation: () => Promise<T> | T): Promise<T> {
  if (!userId || userId.length > 200) throw new AppError(401, '用户会话无效');
  const inherited = scope.getStore();
  if (inherited) {
    if (inherited !== userId) throw new AppError(403, '禁止跨账号使用业务上下文');
    return operation();
  }
  const prior = queues.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(userId, next);
  await prior.catch(() => undefined);
  try {
    return await scope.run(userId, () => withDatabaseTenant(userId, async () => operation()));
  } finally {
    release();
    if (queues.get(userId) === next) queues.delete(userId);
  }
}

/** PostgreSQL reads get an isolated RLS connection without waiting for long-running AI mutations. */
export async function withTenantRead<T>(
  userId: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!userId || userId.length > 200) throw new AppError(401, '用户会话无效');
  const inherited = scope.getStore();
  if (inherited) {
    if (inherited !== userId) throw new AppError(403, '禁止跨账号使用业务上下文');
    return operation();
  }
  return scope.run(userId, () => withDatabaseTenant(userId, async () => operation(), false));
}
