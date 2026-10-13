import { publishAtomicFile } from './atomic-file';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors';
import { dataDirectory } from './product-repository';

export const SESSION_COOKIE = 'productspy_session';
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_ACTIVE_SESSIONS = 128;
const MAX_NEW_SESSIONS_PER_MINUTE = 30;
const CODE_LIFETIME_MS = 120_000;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const HASH = /^[a-f0-9]{64}$/;

interface Credentials {
  version: 1;
  extensionOrigin: string;
  tokenHash: string;
}
interface AuthState {
  tail: Promise<unknown>;
  sessions: Map<string, { host: string; expiresAt: number }>;
  sessionIssues: Map<string, number[]>;
  code?: { hash: string; expiresAt: number };
  credentials: Credentials | null;
}
interface AuthRegistry {
  states: Map<string, AuthState>;
  failedPairs: number[];
}
const authGlobal = globalThis as typeof globalThis & { __productspyAuth?: AuthRegistry };
const registry = (authGlobal.__productspyAuth ??= { states: new Map(), failedPairs: [] });

function state(): AuthState {
  const directory = dataDirectory();
  let current = registry.states.get(directory);
  if (!current) {
    current = {
      tail: Promise.resolve(),
      sessions: new Map(),
      sessionIssues: new Map(),
      credentials: null,
    };
    registry.states.set(directory, current);
  }
  current.sessionIssues ??= new Map();
  return current;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalHash(left: string, right: string): boolean {
  return (
    HASH.test(left) &&
    HASH.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}

export function isExtensionOrigin(origin: string): boolean {
  return EXTENSION_ORIGIN.test(origin);
}

export function pairedOrigin(origin: string): boolean {
  return state().credentials?.extensionOrigin === origin;
}

async function loadCredentials(): Promise<Credentials | null> {
  let source: string;
  try {
    source = await readFile(join(dataDirectory(), '.bridge-credentials.json'), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      state().credentials = null;
      return null;
    }
    throw new AppError(500, '无法读取本机扩展配对配置，请检查工作台文件权限');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch {
    raw = null;
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('version' in raw) ||
    raw.version !== 1 ||
    !('extensionOrigin' in raw) ||
    typeof raw.extensionOrigin !== 'string' ||
    !isExtensionOrigin(raw.extensionOrigin) ||
    !('tokenHash' in raw) ||
    typeof raw.tokenHash !== 'string' ||
    !HASH.test(raw.tokenHash)
  ) {
    throw new AppError(500, '本机扩展配对配置损坏，请在工作台撤销后重新配对');
  }
  const credentials: Credentials = {
    version: 1,
    extensionOrigin: raw.extensionOrigin,
    tokenHash: raw.tokenHash,
  };
  state().credentials = credentials;
  return credentials;
}

function transaction<T>(operation: () => Promise<T>): Promise<T> {
  const current = state();
  const result = current.tail.catch(() => undefined).then(operation);
  current.tail = result.catch(() => undefined);
  return result;
}

async function writeCredentials(credentials: Credentials): Promise<void> {
  const directory = dataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryFile = join(directory, `.bridge-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryFile, JSON.stringify(credentials), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await publishAtomicFile(temporaryFile, join(directory, '.bridge-credentials.json'));
    state().credentials = credentials;
  } catch {
    throw new AppError(500, '无法保存本机扩展配对配置，请检查工作台文件权限');
  } finally {
    await unlink(temporaryFile).catch(() => undefined);
  }
}

export function assertWebContext(request: Request, requireOrigin = false): void {
  const host = requestHost(request);
  const origin = request.headers.get('origin');
  if (
    (origin && origin !== `http://${host}`) ||
    (requireOrigin && !origin) ||
    request.headers.get('sec-fetch-site') !== 'same-origin'
  ) {
    throw new AppError(403, '请从当前本机 ProductSpy 工作台发起请求');
  }
}

/** Next can normalize request.url to localhost; browser origin follows the actual Host. */
export function requestHost(request: Request): string {
  return (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
}

function cookieValue(request: Request): string | undefined {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

export function createWebSession(request: Request): string {
  assertWebContext(request, true);
  const current = state();
  const now = Date.now();
  for (const [key, session] of current.sessions)
    if (session.expiresAt <= now) current.sessions.delete(key);
  const host = requestHost(request);
  const existingToken = cookieValue(request);
  const existing =
    existingToken && HASH.test(existingToken)
      ? current.sessions.get(hash(existingToken))
      : undefined;
  if (existingToken && existing && existing.host === host && existing.expiresAt > now)
    return existingToken;
  if (current.sessions.size >= MAX_ACTIVE_SESSIONS) {
    throw new AppError(429, '工作台活跃会话过多，请使用已打开的工作台窗口或稍后重试');
  }
  const issued = (current.sessionIssues.get(host) ?? []).filter((time) => time > now - 60_000);
  current.sessionIssues.set(host, issued);
  if (issued.length >= MAX_NEW_SESSIONS_PER_MINUTE) {
    throw new AppError(429, '工作台连接尝试过于频繁，请一分钟后重试');
  }
  issued.push(now);
  const token = randomBytes(32).toString('hex');
  current.sessions.set(hash(token), {
    host,
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000,
  });
  return token;
}

export function assertWebSession(request: Request): void {
  assertWebContext(request);
  const token = cookieValue(request);
  const session = token && HASH.test(token) ? state().sessions.get(hash(token)) : undefined;
  if (!session || session.expiresAt <= Date.now() || session.host !== requestHost(request)) {
    throw new AppError(401, '工作台会话已失效，请刷新页面后重试');
  }
}

export async function assertAuthentication(request: Request, webOnly = false): Promise<void> {
  const origin = request.headers.get('origin') ?? '';
  if (!isExtensionOrigin(origin)) {
    assertWebSession(request);
    return;
  }
  if (webOnly) throw new AppError(403, '此操作仅允许在 ProductSpy 工作台中完成');
  const credentials = await loadCredentials();
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (
    request.headers.get('x-productspy-client') !== 'extension' ||
    !credentials ||
    credentials.extensionOrigin !== origin ||
    !HASH.test(token) ||
    !equalHash(hash(token), credentials.tokenHash)
  ) {
    throw new AppError(401, '扩展尚未配对或配对已撤销，请在工作台生成配对码后重新连接');
  }
}

export async function refreshPairedOrigin(): Promise<void> {
  await loadCredentials();
}

export function generatePairCode(): { code: string; expiresAt: string } {
  const code = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + CODE_LIFETIME_MS;
  state().code = { hash: hash(code), expiresAt };
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export async function pairExtension(origin: string, code: unknown): Promise<{ token: string }> {
  return transaction(async () => {
    const now = Date.now();
    registry.failedPairs = registry.failedPairs.filter((time) => time > now - 60_000);
    if (registry.failedPairs.length >= 10)
      throw new AppError(429, '配对尝试过于频繁，请一分钟后重试');
    const activeCode = state().code;
    if (
      !isExtensionOrigin(origin) ||
      typeof code !== 'string' ||
      !/^[a-f0-9]{32}$/.test(code) ||
      !activeCode ||
      activeCode.expiresAt <= now ||
      !equalHash(hash(code), activeCode.hash)
    ) {
      registry.failedPairs.push(now);
      throw new AppError(401, '配对码无效、已使用或已过期，请在工作台重新生成');
    }
    const token = randomBytes(32).toString('hex');
    await writeCredentials({ version: 1, extensionOrigin: origin, tokenHash: hash(token) });
    if (state().code?.hash === activeCode.hash) state().code = undefined;
    return { token };
  });
}

export async function revokeExtension(): Promise<void> {
  await transaction(async () => {
    try {
      await unlink(join(dataDirectory(), '.bridge-credentials.json'));
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw new AppError(500, '无法撤销扩展配对，请检查工作台文件权限');
      }
    }
    state().credentials = null;
    state().code = undefined;
  });
}

export async function bridgeStatus(): Promise<{ paired: boolean }> {
  return { paired: Boolean(await loadCredentials()) };
}
