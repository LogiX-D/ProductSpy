import { rename } from 'node:fs/promises';

const WINDOWS_SHARING_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Retry only the atomic rename when Windows briefly holds a file open. Never unlink the
 * destination, repeat a product mutation, or reissue an AI/network request. */
export async function publishAtomicFile(
  source: string,
  destination: string,
  operations: {
    rename: (source: string, destination: string) => Promise<void>;
    delay: (ms: number) => Promise<void>;
    windows: boolean;
  } = {
    rename,
    delay: (ms) => new Promise((done) => setTimeout(done, ms)),
    windows: process.platform === 'win32',
  },
): Promise<void> {
  const waits = [20, 50, 100, 200];
  for (let attempt = 0; ; attempt++) {
    try {
      await operations.rename(source, destination);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (
        !operations.windows ||
        typeof code !== 'string' ||
        !WINDOWS_SHARING_ERRORS.has(code) ||
        attempt >= waits.length
      )
        throw error;
      await operations.delay(waits[attempt]);
    }
  }
}
