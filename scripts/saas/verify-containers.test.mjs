import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const script = resolve('scripts/saas/verify-containers.mjs');

async function rejected(overrides, message) {
  const result = await execute(process.execPath, [script], {
    windowsHide: true,
    env: {
      ...process.env,
      PRODUCTSPY_CONTAINER_VERIFY: '1',
      PRODUCTSPY_TEST_DATABASE_URL: 'postgresql://test_app@127.0.0.1:59999/test_only',
      DOCKER_HOST: '',
      DOCKER_CONTEXT: '',
      DOCKER_TLS_VERIFY: '',
      DOCKER_CERT_PATH: '',
      GITHUB_ACTIONS: '',
      RUNNER_OS: 'Windows',
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

describe('container verifier execution boundaries', () => {
  it('requires an explicit opt-in before starting anything', async () => {
    await rejected({ PRODUCTSPY_CONTAINER_VERIFY: '' }, 'Set PRODUCTSPY_CONTAINER_VERIFY=1');
  });

  it('requires an explicit temporary database', async () => {
    await rejected({ PRODUCTSPY_TEST_DATABASE_URL: '' }, 'Set an explicit temporary');
  });

  it('rejects remote PostgreSQL without echoing the password', async () => {
    const result = await rejected(
      {
        PRODUCTSPY_TEST_DATABASE_URL:
          'postgresql://test_app:synthetic-never-print@db.example.invalid/test_only',
      },
      'Only a loopback temporary PostgreSQL test database is allowed',
    );
    expect(result.stderr).not.toContain('synthetic-never-print');
  });

  it('rejects query and fragment connection overrides', async () => {
    for (const suffix of ['?host=remote.example.invalid', '#host=remote.example.invalid'])
      await rejected(
        {
          PRODUCTSPY_TEST_DATABASE_URL: `postgresql://test_app@127.0.0.1/test_only${suffix}`,
        },
        'Database URL query options and fragments are forbidden',
      );
  });

  it('rejects malformed URLs without echoing credential-bearing input', async () => {
    const result = await rejected(
      {
        PRODUCTSPY_TEST_DATABASE_URL:
          'postgresql://test_app:synthetic-invalid-secret@[not-an-ip]/test_only',
      },
      'Invalid URL',
    );
    expect(result.stderr).not.toContain('synthetic-invalid-secret');
  });

  it('refuses remote or overridden Docker configuration', async () => {
    await rejected(
      { DOCKER_HOST: 'tcp://remote.example.invalid:2376' },
      'Remote or overridden Docker configuration DOCKER_HOST is forbidden',
    );
    await rejected(
      { DOCKER_CONTEXT: 'production' },
      'Remote or overridden Docker configuration DOCKER_CONTEXT is forbidden',
    );
  });

  it('refuses execution outside GitHub Actions', async () => {
    await rejected({}, 'This verifier runs only inside GitHub Actions');
  });

  it('refuses a non-Linux CI runner', async () => {
    await rejected(
      { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows' },
      'This verifier requires a Linux CI runner',
    );
  });

  it('runs the actual Dockerfile health command against its configured random PORT', async () => {
    // A local Node HTTP check proves command behavior only; it is not Docker evidence.
    const dockerfile = await readFile(resolve('Dockerfile'), 'utf8');
    const command = dockerfile.match(/^HEALTHCHECK .* CMD node -e "(.*)"$/m)?.[1];
    expect(command).toBeTruthy();
    let configuredPortRequested = false;
    const server = createServer((request, response) => {
      if (request.url === '/api/health') configuredPortRequested = true;
      response.writeHead(request.url === '/api/health' ? 200 : 404);
      response.end('health-command-fixture');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const result = await execute(process.execPath, ['-e', command], {
        windowsHide: true,
        timeout: 10_000,
        env: { ...process.env, PORT: String(server.address().port) },
      });
      expect(result.stderr).toBe('');
      expect(configuredPortRequested).toBe(true);
    } finally {
      await new Promise((complete, reject) =>
        server.close((error) => (error ? reject(error) : complete())),
      );
    }
  });
});
