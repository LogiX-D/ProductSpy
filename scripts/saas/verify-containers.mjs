import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from '../../apps/web/node_modules/pg/lib/index.js';

const execute = promisify(execFile);
const label = 'productspy.verification.run';
const origin = 'https://productspy-container.test.invalid';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wait = (milliseconds) => new Promise((complete) => setTimeout(complete, milliseconds));

function configuration() {
  assert.equal(
    process.env.PRODUCTSPY_CONTAINER_VERIFY,
    '1',
    'Set PRODUCTSPY_CONTAINER_VERIFY=1 explicitly for this isolated CI verification.',
  );
  const raw = process.env.PRODUCTSPY_TEST_DATABASE_URL;
  assert(raw, 'Set an explicit temporary PRODUCTSPY_TEST_DATABASE_URL.');
  const database = new URL(raw);
  assert(['postgres:', 'postgresql:'].includes(database.protocol), 'PostgreSQL URL required.');
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname),
    'Only a loopback temporary PostgreSQL test database is allowed.',
  );
  assert(
    !database.search && !database.hash,
    'Database URL query options and fragments are forbidden.',
  );
  assert(/^\/[A-Za-z0-9_]+$/.test(database.pathname), 'Explicit test database name required.');
  assert(database.username, 'Explicit restricted application role required.');
  if (database.hostname === 'localhost') database.hostname = '127.0.0.1';
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
    assert(!process.env[key], `Remote or overridden Docker configuration ${key} is forbidden.`);
  assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'This verifier runs only inside GitHub Actions.',
  );
  assert.equal(process.env.RUNNER_OS, 'Linux', 'This verifier requires a Linux CI runner.');
  assert.equal(process.platform, 'linux', 'This verifier requires a Linux CI runner.');
  const revision = process.env.GITHUB_SHA;
  assert(/^[a-f0-9]{40}$/.test(revision || ''), 'Explicit current GitHub commit SHA required.');
  return { database, revision };
}

// Never forward raw Docker stderr, environment, HTTP bodies, or full inspect output.
// Error categories and byte counts are sufficient for the public CI report.
function outputSummary(stdout = '', stderr = '') {
  const text = `${stdout}\n${stderr}`;
  return {
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    categories: [
      'MODULE_NOT_FOUND',
      'ERR_MODULE_NOT_FOUND',
      'ECONNREFUSED',
      'EACCES',
      'ENOENT',
      'permission denied',
      'port is already allocated',
    ].filter((code) => text.includes(code)),
  };
}

async function docker(args, env = process.env, timeout = 30_000) {
  try {
    return await execute('docker', ['--context', 'default', ...args], {
      env,
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const failure = new Error(`Docker ${args[0]} failed (${error.code ?? 'unknown'}).`);
    failure.summary = outputSummary(error.stdout, error.stderr);
    throw failure;
  }
}

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((complete, reject) =>
    probe.close((error) => (error ? reject(error) : complete())),
  );
  return port;
}

async function request(base, path, method = 'GET', data, cookie, status = 200) {
  const response = await new Promise((complete, reject) => {
    const outgoing = httpRequest(
      `${base}${path}`,
      {
        method,
        timeout: 15_000,
        headers: {
          Host: new URL(origin).host,
          Origin: origin,
          'X-ProductSpy-Client': 'web',
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (incoming) => {
        const chunks = [];
        let size = 0;
        incoming.on('data', (chunk) => {
          size += chunk.length;
          if (size > 3 * 1024 * 1024) incoming.destroy(new Error('Unexpected oversized response.'));
          else chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          const headers = new Headers();
          for (const [key, values] of Object.entries(incoming.headers))
            for (const value of Array.isArray(values) ? values : [values])
              if (value !== undefined) headers.append(key, value);
          complete(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.on('timeout', () => outgoing.destroy(new Error('Container HTTP request timed out.')));
    if (data !== undefined) outgoing.write(JSON.stringify(data));
    outgoing.end();
  });
  assert.equal(response.status, status, `${method} ${path} returned unexpected HTTP status.`);
  const body = await response.json();
  if (status < 400)
    assert.equal(body.ok, true, `${method} ${path} returned a failed API envelope.`);
  return { response, data: body.data };
}

function accountCookie(response) {
  const value = response.headers.get('set-cookie');
  assert(
    value?.includes('Secure') && value.includes('HttpOnly'),
    'Expected Secure HttpOnly cookie.',
  );
  return value.split(';')[0];
}

async function main() {
  const { database, revision } = configuration();
  const runId = randomUUID().replaceAll('-', '');
  const marker = `Synthetic container verification ${runId}`;
  const accounts = [
    { email: `container-owner-${runId}@example.invalid`, name: marker },
    { email: `container-other-${runId}@example.invalid`, name: marker },
  ];
  const password = `Synthetic-container-${randomBytes(24).toString('hex')}`;
  const ownedNames = new Set();
  const attemptedAccounts = new Set();
  const directory = resolve('.test-data/saas/containers', runId);
  const reportFile = resolve(directory, 'report.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = {
    status: 'FAIL',
    runId,
    revision,
    startedAt: new Date().toISOString(),
    scope:
      'Actual local Linux CI Docker runtime and worker, host networking bound to loopback; no cloud, external TLS, or physical cross-device verification',
    fixture:
      'Synthetic product and accounts, Mock AI, billing disabled; no external provider calls',
    checks: [],
    containers: [],
  };
  const client = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 5000 });
  let connected = false;
  let failure;
  const containerEnv = {
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    PRODUCTSPY_MODE: 'saas',
    PRODUCTSPY_ENV: 'production',
    PRODUCTSPY_APP_URL: origin,
    PRODUCTSPY_JOB_RUNNER: 'external',
    PRODUCTSPY_DB_DRIVER: 'pg',
    PRODUCTSPY_AUTO_MIGRATE: '0',
    PRODUCTSPY_ARCHIVE_SECRET: randomBytes(48).toString('hex'),
    DATABASE_URL: database.href,
    HOSTNAME: '127.0.0.1',
    PORT: '',
    AI_MODE: 'mock',
    AI_API_KEY: '',
    AI_BASE_URL: 'https://ai-disabled.example.invalid/v1',
    STRIPE_SECRET_KEY: '',
    STRIPE_PRICE_PRO: '',
    STRIPE_WEBHOOK_SECRET: '',
    PRODUCTSPY_ENABLE_LIVE_BILLING: '0',
  };

  async function assertOwned(name) {
    assert(ownedNames.has(name), 'Container name is outside this verifier run.');
    const result = await docker([
      'inspect',
      '--type',
      'container',
      '--format',
      `{{index .Config.Labels "${label}"}}`,
      name,
    ]);
    assert(result.stdout.trim() === runId, 'Container ownership label changed; refusing cleanup.');
  }

  async function removeOwned(name) {
    await assertOwned(name);
    await docker(['rm', '--force', name]);
    ownedNames.delete(name);
    const container = report.containers.find((item) => item.name === name);
    if (container) container.removed = true;
  }

  async function startContainer(name, image, web = false) {
    const args = [
      'run',
      '--detach',
      '--pull=never',
      '--network',
      'host',
      '--name',
      name,
      '--label',
      `${label}=${runId}`,
    ];
    if (web)
      args.push(
        '--health-interval=1s',
        '--health-timeout=3s',
        '--health-start-period=1s',
        '--health-retries=60',
      );
    for (const key of Object.keys(containerEnv)) args.push('-e', key);
    args.push(image);
    if (!web)
      args.push('node', 'node_modules/tsx/dist/cli.mjs', 'scripts/saas/worker.ts', '--once');
    ownedNames.add(name);
    await docker(args, { ...process.env, ...containerEnv });
    await assertOwned(name);
    report.containers.push({ name, image, kind: web ? 'web' : 'worker' });
  }

  async function healthy(name) {
    for (let attempt = 0; attempt < 90; attempt++) {
      const state = (
        await docker([
          'inspect',
          '--type',
          'container',
          '--format',
          '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}',
          name,
        ])
      ).stdout.trim();
      if (state === 'running healthy') return;
      assert(state.startsWith('running '), 'Web container stopped before becoming healthy.');
      assert(!state.endsWith('missing'), 'Web image does not define a real Docker HEALTHCHECK.');
      assert(
        !state.endsWith('unhealthy'),
        'Docker HEALTHCHECK marked the web container unhealthy.',
      );
      await wait(1000);
    }
    throw new Error('Docker HEALTHCHECK did not become healthy within 90 seconds.');
  }

  async function register(base, account) {
    attemptedAccounts.add(account.email);
    const result = await request(base, '/api/auth/register', 'POST', { ...account, password });
    assert(result.data?.user?.id, 'Registration did not return an account ID.');
    return accountCookie(result.response);
  }

  try {
    const endpoint = (
      await docker(['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}'])
    ).stdout.trim();
    assert(
      endpoint === 'unix:///var/run/docker.sock',
      'Only the local CI Docker daemon is allowed.',
    );
    report.images = [];
    for (const image of ['productspy-web:ci', 'productspy-worker:ci']) {
      const metadata = (
        await docker([
          'image',
          'inspect',
          '--format',
          '{{.Id}}\n{{.Config.User}}\n{{index .Config.Labels "org.opencontainers.image.revision"}}',
          image,
        ])
      ).stdout
        .trim()
        .split('\n');
      assert(/^sha256:[a-f0-9]{64}$/.test(metadata[0]), 'Expected a local image content ID.');
      assert(metadata[1] === 'node', 'Verification images must run as the non-root node user.');
      assert(metadata[2] === revision, 'Local image was not labeled with this checkout commit.');
      report.images.push({ image, id: metadata[0], revision: metadata[2], user: metadata[1] });
    }
    await client.connect();
    connected = true;
    const role = (
      await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    ).rows[0];
    assert(role && !role.rolsuper && !role.rolbypassrls, 'Use a NOSUPERUSER NOBYPASSRLS app role.');
    assert.equal(
      (await client.query('SELECT count(*)::integer AS count FROM job_dispatch')).rows[0].count,
      0,
      'The temporary test database has other queued work; refusing to consume it.',
    );
    assert.equal(
      (
        await client.query('SELECT id FROM users WHERE email=ANY($1::text[])', [
          accounts.map((a) => a.email),
        ])
      ).rowCount,
      0,
      'Synthetic account collision; refusing to reuse existing accounts.',
    );
    const port = await availablePort();
    containerEnv.PORT = String(port);
    const base = `http://127.0.0.1:${port}`;
    report.port = port;
    const firstWeb = `productspy-web-ci-${runId}-first`;
    await startContainer(firstWeb, 'productspy-web:ci', true);
    await healthy(firstWeb);
    report.checks.push('actual Docker HEALTHCHECK healthy on a random PORT');
    const ownerCookie = await register(base, accounts[0]);
    const product = (
      await request(
        base,
        '/api/products',
        'POST',
        {
          source: 'amazon',
          sourceId: 'B033333333',
          url: 'https://www.amazon.com/dp/B033333333',
          title: 'Synthetic container persistence product',
          images: [],
          videos: [],
          bulletPoints: ['Synthetic fixture; no Amazon network request'],
        },
        ownerCookie,
      )
    ).data;
    assert.equal(
      (await request(base, '/api/products', 'GET', undefined, ownerCookie)).data.length,
      1,
    );
    report.checks.push('registration, Secure HttpOnly cookie, product save and list');
    const jobId = randomUUID();
    const queued = await request(
      base,
      '/api/jobs',
      'POST',
      { endpoint: '/api/analyze-product', input: { requestId: jobId, product } },
      ownerCookie,
      202,
    );
    assert.equal(queued.data.status, 'queued');
    assert.equal(
      (await request(base, `/api/jobs/${jobId}`, 'GET', undefined, ownerCookie)).data.status,
      'queued',
    );
    const dispatch = (await client.query('SELECT user_id,id FROM job_dispatch')).rows;
    assert.equal(dispatch.length, 1, 'Another queued task appeared; refusing to start the worker.');
    assert.equal(dispatch[0].id, jobId);
    report.checks.push('durable task remains queued before an independent worker exists');
    const workerName = `productspy-worker-ci-${runId}`;
    await startContainer(workerName, 'productspy-worker:ci');
    const exit = (await docker(['wait', workerName], process.env, 90_000)).stdout.trim();
    assert(exit === '0', 'Independent worker container did not exit successfully.');
    assert.equal(
      (await request(base, `/api/jobs/${jobId}`, 'GET', undefined, ownerCookie)).data.status,
      'succeeded',
    );
    const path = `/api/products/${encodeURIComponent(product.id)}`;
    const saved = (await request(base, path, 'GET', undefined, ownerCookie)).data;
    assert(saved.aiAnalysis?.hooks?.length >= 5, 'Saved Mock analysis is missing.');
    assert(saved.analysisHistory?.length >= 1, 'Product analysisHistory was not saved.');
    const history = (await request(base, `${path}/analysis-history`, 'GET', undefined, ownerCookie))
      .data;
    assert(history.length >= 1, 'Analysis-history API returned no saved version.');
    const savedChecksum = hash(saved);
    const historyChecksum = hash(history);
    report.checks.push(
      'independent worker container exit 0, succeeded job and saved analysisHistory',
    );
    await removeOwned(firstWeb);
    const secondWeb = `productspy-web-ci-${runId}-second`;
    await startContainer(secondWeb, 'productspy-web:ci', true);
    await healthy(secondWeb);
    const login = await request(base, '/api/auth/login', 'POST', {
      email: accounts[0].email,
      password,
    });
    const freshCookie = accountCookie(login.response);
    assert.equal(
      hash((await request(base, path, 'GET', undefined, freshCookie)).data),
      savedChecksum,
    );
    assert.equal(
      hash((await request(base, `${path}/analysis-history`, 'GET', undefined, freshCookie)).data),
      historyChecksum,
    );
    const otherCookie = await register(base, accounts[1]);
    assert.equal(
      (await request(base, '/api/products', 'GET', undefined, otherCookie)).data.length,
      0,
    );
    await request(base, path, 'GET', undefined, otherCookie, 404);
    await request(base, `${path}/analysis-history`, 'GET', undefined, otherCookie, 404);
    await request(base, `/api/jobs/${jobId}`, 'GET', undefined, otherCookie, 404);
    report.savedProductSha256 = savedChecksum;
    report.savedHistorySha256 = historyChecksum;
    report.checks.push(
      'web destruction/recreation, fresh login and identical product/history checksums',
    );
    report.checks.push('second account empty library and product/history/job HTTP 404 isolation');
    report.status = 'PASS';
  } catch (error) {
    failure = error;
    // Known assertion messages omit request bodies and credentials. Network/parser errors are reduced.
    report.error =
      error instanceof assert.AssertionError ? error.message : 'Container verification failed.';
    if (error.summary) report.errorSummary = error.summary;
  } finally {
    report.cleanup = { containers: [], users: [] };
    for (const name of [...ownedNames].reverse()) {
      const cleanup = { name, removed: false };
      try {
        await assertOwned(name);
        try {
          const logs = await docker(['logs', '--tail', '40', name]);
          cleanup.logs = outputSummary(logs.stdout, logs.stderr);
        } catch {
          cleanup.logs = { unavailable: true };
        }
        await removeOwned(name);
        cleanup.removed = true;
      } catch {
        report.status = 'FAIL';
        if (!failure) failure = new Error('Could not safely clean up an owned test container.');
      }
      report.cleanup.containers.push(cleanup);
    }
    if (connected) {
      for (const account of accounts.filter((a) => attemptedAccounts.has(a.email))) {
        try {
          const row = (
            await client.query('SELECT id,name FROM users WHERE email=$1', [account.email])
          ).rows[0];
          if (row) {
            assert.equal(row.name, marker, 'Synthetic account ownership marker changed.');
            const deleted = await client.query(
              'DELETE FROM users WHERE id=$1 AND email=$2 AND name=$3',
              [row.id, account.email, marker],
            );
            assert.equal(
              deleted.rowCount,
              1,
              'Synthetic account cleanup did not delete its owned row.',
            );
          }
          report.cleanup.users.push({ removed: true });
        } catch {
          report.cleanup.users.push({ removed: false });
          report.status = 'FAIL';
          if (!failure)
            failure = new Error('Could not safely clean up an owned synthetic account.');
        }
      }
    }
    await client.end();
    report.finishedAt = new Date().toISOString();
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(
      JSON.stringify({
        status: report.status,
        report: reportFile,
        checks: report.checks,
        error: report.error,
        errorSummary: report.errorSummary,
        cleanup: report.cleanup,
      }),
    );
  }
  if (failure) {
    // Avoid Node network error details that might contain a configured connection string.
    throw new Error('Container verification failed; inspect the sanitized local report.');
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Container verification failed.');
  process.exitCode = 1;
});
