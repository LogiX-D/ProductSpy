import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/saas/verify-live-workflow.mjs');
const secret = 'synthetic-password-must-never-appear';
describe('manual live workflow CLI refuses unsafe targets before connecting', () => {
  it.each([
    '',
    `invalid:${secret}[`,
    `postgresql://app:${secret}@public.example.invalid/productspy_live_test`,
    `postgresql://app:${secret}@127.0.0.1/production`,
    `postgresql://app:${secret}@127.0.0.1/productspy_live_test?host=public.example.invalid`,
    `postgresql://app:${secret}@127.0.0.1/productspy_live_test#untrusted`,
  ])('fails closed without exposing the target credential (%#)', async (target) => {
    let failure;
    try {
      await promisify(execFile)(process.execPath, [script], {
        env: { ...process.env, PRODUCTSPY_TEST_DATABASE_URL: target },
        timeout: 10000,
        windowsHide: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toMatch(
      /empty local test database|dedicated loopback|Invalid test database/,
    );
    expect(failure.stderr).not.toContain(secret);
  });
});
