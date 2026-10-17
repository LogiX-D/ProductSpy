import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const script = resolve('scripts/saas/verify-logical-recovery.mjs');

async function rejected(overrides, message) {
  const result = await execute(process.execPath, [script], {
    windowsHide: true,
    env: {
      ...process.env,
      PRODUCTSPY_LOGICAL_RECOVERY_ALLOW_CREATE: '1',
      PRODUCTSPY_TEST_ADMIN_DATABASE_URL: 'postgresql://test_admin@127.0.0.1:59999/test_only',
      PRODUCTSPY_TEST_DATABASE_URL: 'postgresql://test_app@127.0.0.1:59999/test_only',
      PRODUCTSPY_PG_BIN: '',
      ...overrides,
    },
  }).then(
    () => ({ code: 0, stderr: '' }),
    (error) => ({ code: error.code, stderr: String(error.stderr) }),
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(message);
  return result;
}

describe('logical recovery destructive-operation boundaries', () => {
  it('requires explicit database-creation opt-in before connecting', async () => {
    await rejected(
      { PRODUCTSPY_LOGICAL_RECOVERY_ALLOW_CREATE: '' },
      'Set PRODUCTSPY_LOGICAL_RECOVERY_ALLOW_CREATE=1',
    );
  });

  it('rejects a remote administrator endpoint without echoing credentials', async () => {
    const result = await rejected(
      {
        PRODUCTSPY_TEST_ADMIN_DATABASE_URL:
          'postgresql://test_admin:synthetic-secret-never-print@db.example.invalid/test_only',
      },
      'only a literal loopback test cluster is allowed',
    );
    expect(result.stderr).not.toContain('synthetic-secret-never-print');
  });

  it('rejects connection URL query options that can redirect the host', async () => {
    await rejected(
      {
        PRODUCTSPY_TEST_ADMIN_DATABASE_URL:
          'postgresql://test_admin@127.0.0.1:59999/test_only?host=remote.example.invalid',
      },
      'URL options and fragments are forbidden',
    );
  });

  it('rejects malformed URLs without printing their credential-bearing input', async () => {
    const result = await rejected(
      {
        PRODUCTSPY_TEST_ADMIN_DATABASE_URL:
          'postgresql://test_admin:synthetic-invalid-secret@[not-an-ip]/test_only',
      },
      'Invalid URL',
    );
    expect(result.stderr).not.toContain('synthetic-invalid-secret');
  });

  it('rejects fragments and remote restricted-role endpoints', async () => {
    await rejected(
      {
        PRODUCTSPY_TEST_DATABASE_URL:
          'postgresql://test_app@127.0.0.1:59999/test_only#host=remote.example.invalid',
      },
      'URL options and fragments are forbidden',
    );
    await rejected(
      { PRODUCTSPY_TEST_DATABASE_URL: 'postgresql://test_app@remote.example.invalid/test_only' },
      'only a literal loopback test cluster is allowed',
    );
  });

  it('requires both roles to point at the same loopback cluster', async () => {
    await rejected(
      { PRODUCTSPY_TEST_DATABASE_URL: 'postgresql://test_app@127.0.0.1:59998/test_only' },
      'Test cluster ports differ',
    );
  });

  it('requires a separate restricted app role', async () => {
    await rejected(
      { PRODUCTSPY_TEST_DATABASE_URL: 'postgresql://test_admin@127.0.0.1:59999/test_only' },
      'Use a separate restricted app role',
    );
  });

  it('requires an explicit existing client tools location', async () => {
    await rejected({}, 'Set PRODUCTSPY_PG_BIN');
  });
});
