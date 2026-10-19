import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudSession } from './cloud-session';

const key = 'productspy.cloud-session.v1';
const ownQueue = 'productspy.cloud-queue.v1.user.user-a';
const unassigned = 'productspy.cloud-queue.v1._unassigned';
const sessionA: CloudSession = {
  token: 'a'.repeat(64),
  user: { id: 'user-a', name: 'A', email: 'a@example.test' },
  expiresAt: '2026-11-17T00:00:00.000Z',
};
const sessionB: CloudSession = {
  ...sessionA,
  token: 'b'.repeat(64),
  user: { id: 'user-b', name: 'B', email: 'b@example.test' },
};
function storage(records: Record<string, unknown>) {
  return {
    setAccessLevel: vi.fn(async (): Promise<void> => undefined),
    get: vi.fn(async (name: string) =>
      Object.hasOwn(records, name) ? structuredClone({ [name]: records[name] }) : {},
    ),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(records, structuredClone(values));
    }),
    remove: vi.fn(async (name: string) => {
      delete records[name];
    }),
  };
}
describe('trusted memory credentials, legacy auth migration and queue preservation', () => {
  let disk: Record<string, unknown>;
  let memory: Record<string, unknown>;
  let local: ReturnType<typeof storage>;
  let session: ReturnType<typeof storage>;
  let auth: typeof import('./cloud-session');
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-20T00:00:00.000Z');
    disk = {
      [ownQueue]: { pending: { retained: 'bound-capture' } },
      [unassigned]: { pending: { retained: 'unassigned-capture' } },
      'productspy.local.v1': { pending: { retained: 'legacy-capture' } },
    };
    memory = {};
    local = storage(disk);
    session = storage(memory);
    vi.stubGlobal('chrome', { storage: { local, session }, runtime: { reload: vi.fn() } });
    vi.resetModules();
    auth = await import('./cloud-session');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('writes new credentials only to trusted session memory', async () => {
    await auth.rememberCloudSession(sessionA);
    expect(await auth.cloudSession()).toEqual(sessionA);
    expect(memory[key]).toEqual(sessionA);
    expect(disk[key]).toBeUndefined();
    expect(local.set).not.toHaveBeenCalled();
    expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });
  it('moves a legacy credential only after the memory write and preserves all queue namespaces', async () => {
    const queues = structuredClone(disk);
    disk[key] = sessionA;
    await expect(auth.cloudSession()).resolves.toEqual(sessionA);
    expect(memory[key]).toEqual(sessionA);
    expect(disk).toEqual(queues);
    expect(local.remove).toHaveBeenCalledExactlyOnceWith(key);
    expect(local.set).not.toHaveBeenCalled();
    vi.resetModules();
    const restartedWorker = await import('./cloud-session');
    expect(await restartedWorker.cloudSession()).toEqual(sessionA);
    expect(disk).toEqual(queues);
  });
  it('keeps an already current memory account instead of restoring an older disk account', async () => {
    disk[key] = sessionA;
    memory[key] = sessionB;
    expect(await auth.cloudSession()).toEqual(sessionB);
    expect(session.set).not.toHaveBeenCalled();
    expect(disk[key]).toBeUndefined();
    expect(disk[ownQueue]).toBeDefined();
  });
  it('keeps expired identity available for explicit cleanup but never authenticates with it', async () => {
    const expired = { ...sessionA, expiresAt: '2026-10-01T00:00:00.000Z' };
    disk[key] = expired;
    expect(await auth.cloudSession()).toBeUndefined();
    expect(await auth.cloudSession(true)).toEqual(expired);
    expect(await auth.stillCloudSession(sessionA)).toBe(false);
    expect(disk[key]).toBeUndefined();
  });
  it('fails closed on access restrictions and retries migration without touching queues', async () => {
    disk[key] = sessionA;
    session.setAccessLevel.mockRejectedValueOnce(new Error('API failure'));
    await expect(auth.cloudSession()).rejects.toThrow('安全保存');
    expect(disk[key]).toEqual(sessionA);
    expect(session.set).not.toHaveBeenCalled();
    expect(local.remove).not.toHaveBeenCalled();
    expect(await auth.cloudSession()).toEqual(sessionA);
    expect(disk[key]).toBeUndefined();
    expect(disk[unassigned]).toBeDefined();
  });
  it('retains the legacy credential if a memory write fails, with no persistent fallback write', async () => {
    disk[key] = sessionA;
    session.set.mockRejectedValueOnce(new Error('Memory unavailable'));
    await expect(auth.cloudSession()).rejects.toThrow('安全保存');
    expect(disk[key]).toEqual(sessionA);
    expect(local.remove).not.toHaveBeenCalled();
    expect(local.set).not.toHaveBeenCalled();
    expect(await auth.cloudSession()).toEqual(sessionA);
    expect(disk[key]).toBeUndefined();
  });
  it('retries removal after a partial migration without overwriting the memory session', async () => {
    disk[key] = sessionA;
    local.remove.mockRejectedValueOnce(new Error('Disk busy'));
    await expect(auth.cloudSession()).rejects.toThrow('安全保存');
    expect(memory[key]).toEqual(sessionA);
    expect(disk[key]).toEqual(sessionA);
    expect(await auth.cloudSession()).toEqual(sessionA);
    expect(session.set).toHaveBeenCalledTimes(1);
    expect(local.remove).toHaveBeenCalledTimes(2);
    expect(disk[key]).toBeUndefined();
  });
  it('rejects unsupported session storage instead of using local credentials', async () => {
    disk[key] = sessionA;
    vi.stubGlobal('chrome', { storage: { local } });
    await expect(auth.cloudSession()).rejects.toThrow('更新 Chrome');
    expect(local.get).not.toHaveBeenCalled();
    expect(local.remove).not.toHaveBeenCalled();
  });
  it('keeps the previous account on a failed new sign-in and never writes the new token to disk', async () => {
    memory[key] = sessionA;
    await auth.cloudSession();
    session.set.mockRejectedValueOnce(new Error('Memory full'));
    await expect(auth.rememberCloudSession(sessionB)).rejects.toThrow('Memory full');
    expect(await auth.cloudSession()).toEqual(sessionA);
    expect(local.set).not.toHaveBeenCalled();
    expect(disk[key]).toBeUndefined();
  });
  it('does not let an old logout erase a newer memory account', async () => {
    await auth.rememberCloudSession(sessionA);
    await auth.rememberCloudSession(sessionB);
    await auth.forgetCloudSession(sessionA.token);
    expect(await auth.cloudSession()).toEqual(sessionB);
    await auth.forgetCloudSession(sessionB.token);
    expect(await auth.cloudSession()).toBeUndefined();
    expect(disk[ownQueue]).toBeDefined();
    expect(disk[unassigned]).toBeDefined();
  });
  it('rechecks auth revision after asynchronous storage setup before accepting a canceled sign-in', async () => {
    let unblock!: () => void;
    let began!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    session.setAccessLevel.mockImplementationOnce(() => {
      began();
      return blocked;
    });
    const revision = auth.beginCloudAuthChange();
    const write = auth.rememberCloudSession(sessionA, revision);
    await started;
    auth.beginCloudAuthChange();
    unblock();
    await expect(write).rejects.toThrow('取消');
    expect(session.set).not.toHaveBeenCalled();
    expect(await auth.cloudSession()).toBeUndefined();
  });
  it('requires reauthorization after browser-memory loss while keeping pending data intact', async () => {
    const queues = structuredClone(disk);
    await auth.rememberCloudSession(sessionA);
    delete memory[key];
    vi.resetModules();
    const restartedBrowser = await import('./cloud-session');
    expect(await restartedBrowser.cloudSession(true)).toBeUndefined();
    expect(disk).toEqual(queues);
    await restartedBrowser.rememberCloudSession(sessionA);
    expect(await restartedBrowser.cloudSession()).toEqual(sessionA);
    expect(disk).toEqual(queues);
  });
  it.each([undefined, sessionB])(
    'rolls back a canceled in-flight memory write before queued reads and newer sign-in (%s)',
    async (previous) => {
      if (previous) memory[key] = previous;
      await auth.cloudSession();
      let unblock!: () => void;
      let began!: () => void;
      const blocked = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      session.set.mockImplementationOnce(async (values) => {
        began();
        await blocked;
        Object.assign(memory, structuredClone(values));
      });
      const write = auth.rememberCloudSession(sessionA, auth.beginCloudAuthChange());
      await started;
      const revision = auth.beginCloudAuthChange();
      const read = auth.cloudSession(true);
      const nextWrite = auth.rememberCloudSession(sessionB, revision);
      unblock();
      await expect(write).rejects.toThrow('取消');
      expect(await read).toEqual(previous);
      await nextWrite;
      expect(await auth.cloudSession()).toEqual(sessionB);
      expect(disk[ownQueue]).toBeDefined();
      expect(local.set).not.toHaveBeenCalled();
    },
  );
  it('blocks reads if canceled-write rollback fails and retries recovery before exposing identity', async () => {
    await auth.cloudSession();
    session.set.mockImplementationOnce(async (values) => {
      Object.assign(memory, values);
      auth.beginCloudAuthChange();
    });
    session.remove.mockRejectedValueOnce(new Error('Memory busy'));
    session.remove.mockRejectedValueOnce(new Error('Memory busy'));
    const write = auth.rememberCloudSession(sessionA, auth.beginCloudAuthChange());
    await expect(write).rejects.toThrow('Memory busy');
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
    session.remove.mockRejectedValueOnce(new Error('Still busy'));
    session.remove.mockRejectedValueOnce(new Error('Still busy'));
    await expect(auth.cloudSession()).rejects.toThrow('Still busy');
    expect(await auth.cloudSession()).toBeUndefined();
    expect(memory[key]).toBeUndefined();
    expect(disk[unassigned]).toBeDefined();
  });
  it('clears the canceled credential if restoring the previous identity fails', async () => {
    memory[key] = sessionB;
    await auth.cloudSession();
    session.set.mockImplementationOnce(async (values) => {
      Object.assign(memory, values);
      auth.beginCloudAuthChange();
    });
    session.set.mockRejectedValueOnce(new Error('Cannot restore'));
    await expect(auth.rememberCloudSession(sessionA, auth.beginCloudAuthChange())).rejects.toThrow(
      '取消',
    );
    expect(await auth.cloudSession()).toBeUndefined();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    expect(disk[ownQueue]).toBeDefined();
  });
  it('clears only malformed legacy auth state, never the pending or unassigned data', async () => {
    const queues = structuredClone(disk);
    disk[key] = { token: 'invalid', user: sessionA.user };
    expect(await auth.cloudSession()).toBeUndefined();
    expect(session.set).not.toHaveBeenCalled();
    expect(disk).toEqual(queues);
  });
});
