import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_OPTIONS } from '@productspy/shared';
import {
  readBackupPreferences,
  restoreBackupPreferences,
  WORKSPACE_PREFERENCE_KEYS,
} from './workspace-backup-api';
describe('business preference allowlist', () => {
  it('reads only fixed public business keys and skips corrupt or unknown preference fields', () => {
    const reads: string[] = [];
    const result = readBackupPreferences({
      getItem: (key) => {
        reads.push(key);
        return key === WORKSPACE_PREFERENCE_KEYS.analysis
          ? JSON.stringify({
              version: 1,
              options: DEFAULT_ANALYSIS_OPTIONS,
              pricing: {},
              apiKey: 'private-test-placeholder',
            })
          : null;
      },
    });
    expect(Object.keys(result)).toHaveLength(0);
    expect(reads).toEqual(Object.values(WORKSPACE_PREFERENCE_KEYS));
    expect(reads).not.toContain('productspy:token');
  });
  it('restores validated preferences and never arbitrary localStorage values', () => {
    const writes: string[] = [];
    const storage = {
      setItem: (key: string) => {
        writes.push(key);
      },
    };
    restoreBackupPreferences(
      { analysis: { version: 1, options: DEFAULT_ANALYSIS_OPTIONS, pricing: {} } },
      storage,
    );
    expect(writes).toEqual([WORKSPACE_PREFERENCE_KEYS.analysis]);
    expect(() => restoreBackupPreferences({ auth: 'synthetic-secret' }, storage)).toThrow();
    expect(writes).toHaveLength(1);
  });
});
