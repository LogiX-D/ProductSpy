export const CLOUD_SESSION_KEY = 'productspy.cloud-session.v1';
export interface CloudUser {
  id: string;
  email: string;
  name: string;
}
export interface CloudSession {
  token: string;
  user: CloudUser;
  expiresAt: string;
}

let changes: Promise<unknown> = Promise.resolve();
let authRevision = 0;
export function beginCloudAuthChange(): number {
  return ++authRevision;
}
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = changes.then(operation);
  changes = result.catch(() => undefined);
  return result;
}

export function validCloudSession(value: unknown): value is CloudSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as CloudSession;
  return (
    typeof session.token === 'string' &&
    /^[a-f0-9]{64}$/.test(session.token) &&
    typeof session.expiresAt === 'string' &&
    Number.isFinite(Date.parse(session.expiresAt)) &&
    !!session.user &&
    typeof session.user.id === 'string' &&
    session.user.id.length > 0 &&
    typeof session.user.email === 'string' &&
    typeof session.user.name === 'string'
  );
}

export async function cloudSession(includeExpired = false): Promise<CloudSession | undefined> {
  await changes;
  const data = await chrome.storage.local.get(CLOUD_SESSION_KEY);
  const session: unknown = data[CLOUD_SESSION_KEY];
  return validCloudSession(session) &&
    (includeExpired || Date.parse(session.expiresAt) > Date.now())
    ? session
    : undefined;
}

export function rememberCloudSession(
  session: CloudSession,
  expectedRevision?: number,
): Promise<void> {
  if (!validCloudSession(session) || Date.parse(session.expiresAt) <= Date.now())
    throw new Error('云端返回了无效或过期的登录凭据，请重新授权。');
  return mutate(async () => {
    if (expectedRevision !== undefined && expectedRevision !== authRevision)
      throw new Error('登录操作已被更新的登录或退出操作取消，请重新授权。');
    authRevision += 1;
    await chrome.storage.local.set({ [CLOUD_SESSION_KEY]: session });
  });
}

// Compare before removing so a late 401/logout cannot clear a newly signed-in account.
export function forgetCloudSession(expectedToken: string): Promise<void> {
  return mutate(async () => {
    const data = await chrome.storage.local.get(CLOUD_SESSION_KEY);
    const session: unknown = data[CLOUD_SESSION_KEY];
    if (validCloudSession(session) && session.token === expectedToken)
      await chrome.storage.local.remove(CLOUD_SESSION_KEY);
  });
}

export async function stillCloudSession(expected: CloudSession): Promise<boolean> {
  const current = await cloudSession();
  return current?.token === expected.token && current.user.id === expected.user.id;
}
