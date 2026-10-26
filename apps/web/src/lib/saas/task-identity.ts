import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccountIdentity, AccountUser } from './security';
// This server-only ALS capability is never derived from a network header or serialized token.
const globals = globalThis as typeof globalThis & {
  __productspyTaskIdentity?: AsyncLocalStorage<AccountIdentity>;
};
const identity = (globals.__productspyTaskIdentity ??= new AsyncLocalStorage<AccountIdentity>());
export function taskIdentity() {
  return identity.getStore();
}
export function withTaskIdentity<T>(
  user: AccountUser,
  jobId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return identity.run({ user, kind: 'web', tokenHash: `internal-task:${jobId}` }, operation);
}
