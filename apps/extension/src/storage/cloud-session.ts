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
let initializedArea: chrome.storage.StorageArea | undefined;
let initialization: Promise<void> | undefined;
let canceledWriteRecovery: (() => Promise<void>) | undefined;

async function privateSessionArea(): Promise<chrome.storage.StorageArea> {
  const area = chrome.storage.session;
  if (!area) throw new Error('当前 Chrome 无法安全保存登录会话，请更新 Chrome 后重新授权。');
  if (initializedArea !== area || !initialization) {
    initializedArea = area;
    initialization = (async () => {
      await Promise.all([
        area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
        chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      ]);
      const [memory, disk] = await Promise.all([
        area.get(CLOUD_SESSION_KEY),
        chrome.storage.local.get(CLOUD_SESSION_KEY),
      ]);
      const legacy: unknown = disk[CLOUD_SESSION_KEY];
      // An existing memory session wins over an older disk credential. Remove
      // only the old auth key after the memory write succeeds, never any queue.
      if (!validCloudSession(memory[CLOUD_SESSION_KEY]) && validCloudSession(legacy))
        await area.set({ [CLOUD_SESSION_KEY]: legacy });
      if (legacy !== undefined) await chrome.storage.local.remove(CLOUD_SESSION_KEY);
    })().catch(() => {
      if (initializedArea === area) {
        initializedArea = undefined;
        initialization = undefined;
      }
      throw new Error(
        '无法安全保存登录会话，请重试。待同步资料仍按账号保留，不会改用持久凭证存储。',
      );
    });
  }
  await initialization;
  if (canceledWriteRecovery) {
    await canceledWriteRecovery();
    canceledWriteRecovery = undefined;
  }
  return area;
}
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
  return mutate(async () => {
    const area = await privateSessionArea();
    const session: unknown = (await area.get(CLOUD_SESSION_KEY))[CLOUD_SESSION_KEY];
    return validCloudSession(session) &&
      (includeExpired || Date.parse(session.expiresAt) > Date.now())
      ? session
      : undefined;
  });
}

export function rememberCloudSession(
  session: CloudSession,
  expectedRevision?: number,
): Promise<void> {
  if (!validCloudSession(session) || Date.parse(session.expiresAt) <= Date.now())
    throw new Error('云端返回了无效或过期的登录凭据，请重新授权。');
  return mutate(async () => {
    const area = await privateSessionArea();
    const previous: unknown = (await area.get(CLOUD_SESSION_KEY))[CLOUD_SESSION_KEY];
    if (expectedRevision !== undefined && expectedRevision !== authRevision)
      throw new Error('登录操作已被更新的登录或退出操作取消，请重新授权。');
    const writeRevision = ++authRevision;
    await area.set({ [CLOUD_SESSION_KEY]: session });
    if (writeRevision !== authRevision) {
      // Later mutations are still queued behind this one. Restore the old
      // identity so a queued logout can revoke it; never accept the canceled
      // login or expose it to an outbox upload. Retry a failed rollback before
      // permitting any subsequent read/write in this worker.
      canceledWriteRecovery = async () => {
        try {
          if (validCloudSession(previous)) await area.set({ [CLOUD_SESSION_KEY]: previous });
          else await area.remove(CLOUD_SESSION_KEY);
        } catch {
          try {
            await area.remove(CLOUD_SESSION_KEY);
          } catch (error) {
            // Reload clears session memory even if its mutation API is broken;
            // local pending/unassigned queues survive. Keep reads blocked until
            // that reset completes rather than accepting the canceled token.
            chrome.runtime.reload();
            throw error;
          }
        }
      };
      await canceledWriteRecovery();
      canceledWriteRecovery = undefined;
      throw new Error('登录操作已被更新的登录或退出操作取消，请重新授权。');
    }
  });
}

// Compare before removing so a late 401/logout cannot clear a newly signed-in account.
export function forgetCloudSession(expectedToken: string): Promise<void> {
  return mutate(async () => {
    const area = await privateSessionArea();
    const data = await area.get(CLOUD_SESSION_KEY);
    const session: unknown = data[CLOUD_SESSION_KEY];
    if (validCloudSession(session) && session.token === expectedToken)
      await area.remove(CLOUD_SESSION_KEY);
  });
}

export async function stillCloudSession(expected: CloudSession): Promise<boolean> {
  const current = await cloudSession();
  return current?.token === expected.token && current.user.id === expected.user.id;
}
