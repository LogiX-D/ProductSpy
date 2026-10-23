import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from '../../apps/web/node_modules/pg/lib/index.js';
import { request as httpRequest } from 'node:http';

if (
  !process.env.PRODUCTSPY_TEST_DATABASE_URL ||
  !['127.0.0.1', 'localhost'].includes(new URL(process.env.PRODUCTSPY_TEST_DATABASE_URL).hostname)
)
  throw new Error('Use an explicit local temporary PostgreSQL test database.');
const directory = resolve('apps/web/.next/standalone/apps/web');
await mkdir(resolve(directory, '.next'), { recursive: true });
await cp(resolve('apps/web/.next/static'), resolve(directory, '.next/static'), { recursive: true });
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = 'https://productspy.test.invalid';
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NODE_ENV: 'production',
  PRODUCTSPY_MODE: 'saas',
  PRODUCTSPY_ENV: 'production',
  PRODUCTSPY_APP_URL: origin,
  PRODUCTSPY_JOB_RUNNER: 'external',
  PRODUCTSPY_DB_DRIVER: 'pg',
  PRODUCTSPY_AUTO_MIGRATE: '0',
  DATABASE_URL: process.env.PRODUCTSPY_TEST_DATABASE_URL,
  HOSTNAME: '127.0.0.1',
  PORT: String(port),
  AI_MODE: 'mock',
};
const server = spawn(process.execPath, [resolve(directory, 'server.js')], {
  cwd: directory,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (data) => {
  output += data;
});
server.stderr.on('data', (data) => {
  output += data;
});
let userId;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
async function request(path, method = 'GET', data, cookie) {
  const response = await new Promise((complete, reject) => {
    const outgoing = httpRequest(
      `${base}${path}`,
      {
        method,
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
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers))
            for (const item of Array.isArray(value) ? value : [value])
              if (item !== undefined) headers.append(key, item);
          complete(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
        });
      },
    );
    outgoing.on('error', reject);
    if (data) outgoing.write(JSON.stringify(data));
    outgoing.end();
  });
  const body = await response.json();
  assert(response.ok, JSON.stringify({ status: response.status, body }));
  return { response, data: body.data };
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Standalone server stopped: ${output}`);
    try {
      const health = await fetch(`${base}/api/health`);
      ready = health.ok;
    } catch {
      /* Server startup. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, 'Standalone health did not become ready');
  const registration = await request('/api/auth/register', 'POST', {
    email: `standalone-${randomUUID()}@example.invalid`,
    password: 'Synthetic-standalone-password-2026',
    name: 'Synthetic Standalone',
  });
  userId = registration.data.user.id;
  const cookieHeader = registration.response.headers.get('set-cookie');
  assert(cookieHeader.includes('Secure'));
  assert(cookieHeader.includes('HttpOnly'));
  const cookie = cookieHeader.split(';')[0];
  const product = (
    await request(
      '/api/products',
      'POST',
      {
        source: 'amazon',
        sourceId: 'B022222222',
        url: 'https://www.amazon.com/dp/B022222222',
        title: 'Synthetic standalone product',
        images: [],
        videos: [],
        bulletPoints: [],
      },
      cookie,
    )
  ).data;
  assert.equal((await request('/api/products', 'GET', undefined, cookie)).data.length, 1);
  const id = randomUUID();
  await request(
    '/api/jobs',
    'POST',
    { endpoint: '/api/analyze-product', input: { requestId: id, product } },
    cookie,
  );
  const worker = spawn(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/saas/worker.ts'), '--once'],
    { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let workerOutput = '';
  worker.stdout.on('data', (data) => {
    workerOutput += data;
  });
  worker.stderr.on('data', (data) => {
    workerOutput += data;
  });
  const [workerCode] = await once(worker, 'close');
  assert.equal(workerCode, 0, workerOutput);
  assert.equal(
    (await request(`/api/jobs/${id}`, 'GET', undefined, cookie)).data.status,
    'succeeded',
  );
  await request('/api/auth/logout', 'POST', {}, cookie);
  console.log(
    JSON.stringify({
      status: 'PASS',
      artifact: 'actual Next standalone server.js',
      database: 'local network PostgreSQL restricted app role',
      checks: [
        'health',
        'registration',
        'Secure HttpOnly cookie',
        'capture',
        'persistence',
        'queued AI',
        'independent worker',
        'saved Mock result',
        'logout',
      ],
      tls: 'No external TLS tested; public HTTPS origin simulated via private reverse-proxy Host/Origin headers',
      ai: 'Mock, no provider calls',
    }),
  );
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'close');
  }
  if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  await pool.end();
}
