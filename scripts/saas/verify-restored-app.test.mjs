import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const runId = 'a'.repeat(32);
const script = resolve('scripts/saas/verify-restored-app.ts');
async function rejected(overrides, message) {
  const result = await execute(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), script],
    {
      windowsHide: true,
      env: {
        ...process.env,
        PRODUCTSPY_RESTORED_APP_VERIFY: '1',
        PRODUCTSPY_RECOVERY_ACTION: 'seed',
        DATABASE_URL: `postgresql://test_app@127.0.0.1:59999/productspy_logical_source_${runId}`,
        PRODUCTSPY_RECOVERY_CREDENTIALS: JSON.stringify(
          [0, 1].map((index) => ({
            email: `logical-recovery-${index}-${runId}@example.invalid`,
            password: `Synthetic-recovery-${'0'.repeat(64)}`,
          })),
        ),
        ...overrides,
      },
    },
  ).then(
    () => ({ code: 0, stderr: '' }),
    (error) => ({ code: error.code, stderr: String(error.stderr) }),
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(message);
  return result;
}

describe('restored application verifier boundaries', () => {
  it('requires explicit opt-in and an allowed action before database work', async () => {
    await rejected({ PRODUCTSPY_RESTORED_APP_VERIFY: '' }, 'Set PRODUCTSPY_RESTORED_APP_VERIFY=1');
    await rejected(
      { PRODUCTSPY_RECOVERY_ACTION: 'migrate-production' },
      'Choose the explicit seed or read verification action',
    );
  });
  it('rejects remote or malformed database URLs without exposing passwords', async () => {
    const remote = await rejected(
      { DATABASE_URL: 'postgresql://test_app:synthetic-never-print@db.example.invalid/test' },
      'Only a loopback PostgreSQL recovery database is allowed',
    );
    expect(remote.stderr).not.toContain('synthetic-never-print');
    const malformed = await rejected(
      { DATABASE_URL: 'postgresql://test_app:synthetic-invalid-secret@[not-an-ip]/test' },
      'Invalid isolated recovery database URL',
    );
    expect(malformed.stderr).not.toContain('synthetic-invalid-secret');
  });
  it('refuses ordinary databases and reversing the source/target action', async () => {
    await rejected(
      { DATABASE_URL: 'postgresql://test_app@127.0.0.1:59999/productspy_test' },
      'Use only the owned source or target recovery database',
    );
    await rejected(
      { PRODUCTSPY_RECOVERY_ACTION: 'read' },
      'Use only the owned source or target recovery database',
    );
  });
  it('rejects connection options and fragments that can redirect the database host', async () => {
    for (const suffix of ['?host=db.example.invalid', '#host=db.example.invalid'])
      await rejected(
        {
          DATABASE_URL: `postgresql://test_app@127.0.0.1:59999/productspy_logical_source_${runId}${suffix}`,
        },
        'Database connection options and fragments are forbidden',
      );
  });
  it('rejects non-synthetic account credentials before connecting', async () => {
    const result = await rejected(
      {
        PRODUCTSPY_RECOVERY_CREDENTIALS: JSON.stringify([
          { email: 'private@example.com', password: 'synthetic-do-not-print-private-input' },
        ]),
      },
      'Only two run-specific synthetic recovery accounts are allowed',
    );
    expect(result.stderr).not.toContain('synthetic-do-not-print-private-input');
  });
});
