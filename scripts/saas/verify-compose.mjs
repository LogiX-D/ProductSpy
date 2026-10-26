import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const markerKey = 'productspy.compose.verification';
const origin = 'https://productspy-compose.test.invalid';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const images = { web: 'productspy-web:ci', worker: 'productspy-worker:ci' };
const tenantTables = [
  'audit_events',
  'capture_events',
  'jobs',
  'subscriptions',
  'usage_events',
  'workspace_documents',
];

export function validateRoleProof(proof) {
  assert(
    Object.values(proof.role).every((value) => value === false),
    'App role has elevated privileges.',
  );
  assert(
    proof.address && !['127.0.0.1', '::1'].includes(proof.address),
    'Database traffic did not use the internal Compose network.',
  );
  assert.deepEqual(
    proof.tenantTables,
    tenantTables.map((name) => ({ name, enabled: true, forced: true })),
    'Expected all six named tenant tables with ENABLE and FORCE RLS.',
  );
  assert.deepEqual(
    proof.channelTables,
    [{ name: 'ai_channel_settings', enabled: true, forced: true }],
    'Global AI channel settings must have ENABLE and FORCE RLS.',
  );
  const normalizePolicy = (expression) =>
    expression
      ?.replaceAll('::text', '')
      .replaceAll(/\s/g, '')
      .replace(/^\((.*)\)$/, '$1');
  assert.deepEqual(
    proof.channelPolicies.map((policy) => ({
      ...policy,
      // pg_policies.roles is name[]; node-postgres may return its native literal.
      roles: policy.roles === '{public}' ? ['public'] : policy.roles,
      qual: normalizePolicy(policy.qual),
      with_check: normalizePolicy(policy.with_check),
    })),
    [
      {
        policyname: 'ai_configuration_scope',
        permissive: 'PERMISSIVE',
        roles: ['public'],
        cmd: 'ALL',
        qual: "current_setting('app.ai_configuration_access',true)='trusted-server'",
        with_check: "current_setting('app.ai_configuration_access',true)='trusted-server'",
      },
    ],
    'Global AI channel policy must require the internal server scope for reads and writes.',
  );
  assert.equal(proof.unscoped, 0, 'Unscoped tenant records must remain invisible.');
  assert.equal(proof.channelProbe.trusted, 1, 'Internal server scope cannot read its canary.');
  assert.equal(proof.channelProbe.unscoped, 0, 'Unmarked app role can read global AI settings.');
  assert.equal(
    proof.channelProbe.userScoped,
    0,
    'A tenant user context must not grant access to global AI settings.',
  );
  assert.equal(
    proof.channelProbe.writeError,
    '42501',
    'Unmarked app writes to global AI settings must be rejected by RLS.',
  );
}

export function configuration(env = process.env, platform = process.platform) {
  assert.equal(env.PRODUCTSPY_COMPOSE_VERIFY, '1', 'Set PRODUCTSPY_COMPOSE_VERIFY=1 explicitly.');
  for (const key of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'COMPOSE_FILE',
    'COMPOSE_PROJECT_NAME',
    'COMPOSE_PROFILES',
    'COMPOSE_ENV_FILES',
    'COMPOSE_DISABLE_ENV_FILE',
  ])
    assert(!env[key], `Overridden Docker or Compose configuration ${key} is forbidden.`);
  assert.equal(env.GITHUB_ACTIONS, 'true', 'This verifier runs only inside GitHub Actions.');
  assert.equal(env.RUNNER_OS, 'Linux', 'This verifier requires a Linux CI runner.');
  assert.equal(platform, 'linux', 'This verifier requires a Linux CI runner.');
  assert(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ''), 'Current GitHub commit SHA required.');
  return { revision: env.GITHUB_SHA };
}

export function composeOverride(environmentFile, runId) {
  assert(/^[a-f0-9]{32}$/.test(runId), 'Invalid isolated run marker.');
  assert(
    environmentFile.startsWith('/') && !environmentFile.includes('\n'),
    'Absolute CI file required.',
  );
  const labels = `      ${markerKey}: ${runId}`;
  // !override prevents Compose from appending the production env_file or original port.
  // The original services, depends_on, db DNS, worker command and data volume remain in use.
  return `services:
  db:
    labels:
${labels}
  web:
    image: ${images.web}
    env_file: !override [${JSON.stringify(environmentFile)}]
    ports: !override ["127.0.0.1:0:3000"]
    labels:
${labels}
  worker:
    image: ${images.worker}
    env_file: !override [${JSON.stringify(environmentFile)}]
    labels:
${labels}
volumes:
  postgres-data:
    labels:
${labels}
networks:
  default:
    labels:
${labels}
`;
}

export function validateModel(model, { project, runId, databaseUrl }) {
  assert.equal(model.name, project, 'Compose project name changed.');
  assert.deepEqual(Object.keys(model.services).sort(), ['db', 'web', 'worker']);
  for (const service of Object.values(model.services)) {
    assert.equal(service.labels[markerKey], runId, 'Service marker missing.');
    assert(
      !service.privileged && !service.network_mode,
      'Privileged or host networking forbidden.',
    );
  }
  assert.equal(model.services.db.image, 'postgres:17-bookworm');
  assert.equal((model.services.db.ports ?? []).length, 0, 'Database host ports forbidden.');
  assert.equal((model.services.worker.ports ?? []).length, 0, 'Worker host ports forbidden.');
  const ports = model.services.web.ports;
  assert.equal(ports.length, 1, 'Only one private web port allowed.');
  assert.equal(ports[0].host_ip, '127.0.0.1', 'Web port must bind IPv4 loopback.');
  assert.equal(String(ports[0].published), '0', 'Web host port must be assigned dynamically.');
  assert.equal(ports[0].target, 3000, 'Original web container port required.');
  for (const kind of ['web', 'worker']) {
    const service = model.services[kind];
    assert.equal(service.image, images[kind], 'Only prebuilt local business images allowed.');
    assert(service.environment.DATABASE_URL === databaseUrl, 'Synthetic app DB URL required.');
    assert.equal(service.environment.PRODUCTSPY_JOB_RUNNER, 'external');
    assert.equal(service.environment.PRODUCTSPY_AUTO_MIGRATE, '0');
    assert.equal(service.environment.PRODUCTSPY_DB_POOL_MAX, '3');
    assert.equal(service.environment.PRODUCTSPY_WORKER_CONCURRENCY, '1');
    assert.equal(service.environment.AI_MODE, 'mock', 'Only Mock AI is allowed.');
    for (const key of [
      'AI_API_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PRICE_PRO',
    ])
      assert(service.environment[key] === '', 'External provider credentials forbidden.');
    assert.equal(service.environment.PRODUCTSPY_ENABLE_LIVE_BILLING, '0');
    assert.equal(service.depends_on.db.condition, 'service_healthy');
    assert(!service.command, 'Original image command must remain in use.');
  }
  const mount = model.services.db.volumes;
  assert.equal(mount.length, 1, 'Original database data mount required.');
  assert.equal(mount[0].type, 'volume');
  assert.equal(mount[0].source, 'postgres-data');
  assert.equal(mount[0].target, '/var/lib/postgresql/data');
  assert.equal(model.volumes['postgres-data'].name, `${project}_postgres-data`);
  assert.equal(model.volumes['postgres-data'].labels[markerKey], runId);
  assert.equal(model.networks.default.name, `${project}_default`);
  assert.equal(model.networks.default.labels[markerKey], runId);
}

export function validateOwnership(labels, project, runId) {
  assert(labels && typeof labels === 'object', 'Resource ownership labels missing.');
  assert.equal(
    labels['com.docker.compose.project'],
    project,
    'Resource project ownership changed.',
  );
  assert.equal(labels[markerKey], runId, 'Resource run marker changed; refusing deletion.');
}

function sanitizedFailure(error) {
  return {
    code: typeof error.code === 'number' ? error.code : 'command_failed',
    stdoutBytes: Buffer.byteLength(error.stdout ?? ''),
    stderrBytes: Buffer.byteLength(error.stderr ?? ''),
    categories: ['ECONNREFUSED', 'MODULE_NOT_FOUND', 'permission denied', 'unhealthy'].filter(
      (code) => `${error.stdout ?? ''}\n${error.stderr ?? ''}`.includes(code),
    ),
  };
}

async function docker(args, env = process.env, timeout = 60_000) {
  try {
    return (
      await execute('docker', ['--context', 'default', ...args], {
        env,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      })
    ).stdout.trim();
  } catch (error) {
    const failure = new Error('Docker operation failed; raw environment and logs are suppressed.');
    failure.summary = sanitizedFailure(error);
    throw failure;
  }
}

async function request(base, path, method = 'GET', data, cookie, expected = 200) {
  const response = await new Promise((done, reject) => {
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
          if (size > 3 * 1024 * 1024) incoming.destroy(new Error('Oversized API response.'));
          else chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () =>
          done({
            status: incoming.statusCode,
            cookie: incoming.headers['set-cookie']?.[0],
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.on('timeout', () => outgoing.destroy(new Error('Compose HTTP request timed out.')));
    if (data !== undefined) outgoing.write(JSON.stringify(data));
    outgoing.end();
  });
  assert.equal(response.status, expected, 'Unexpected Compose API HTTP status.');
  const envelope = JSON.parse(response.body);
  if (expected < 400) assert.equal(envelope.ok, true, 'Compose API envelope rejected.');
  return { data: envelope.data, cookie: response.cookie };
}

function cookie(value) {
  assert(
    value?.includes('Secure') && value.includes('HttpOnly'),
    'Secure HttpOnly cookie required.',
  );
  return value.split(';')[0];
}

async function main() {
  const { revision } = configuration();
  const runId = randomUUID().replaceAll('-', '');
  const project = `productspy-compose-${runId}`;
  const directory = resolve('.test-data/saas/compose', runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privateDirectory = await mkdtemp(resolve(tmpdir(), 'productspy-compose-'));
  const environmentFile = resolve(privateDirectory, 'synthetic.env');
  const overrideFile = resolve(privateDirectory, 'override.yaml');
  const reportFile = resolve(directory, 'report.json');
  const adminPassword = randomBytes(32).toString('hex');
  const appPassword = randomBytes(32).toString('hex');
  const databaseUrl = `postgresql://productspy_app:${appPassword}@db:5432/productspy`;
  const adminUrl = `postgresql://productspy_migrate:${adminPassword}@db:5432/productspy`;
  const appEnv = {
    NODE_ENV: 'production',
    PRODUCTSPY_MODE: 'saas',
    PRODUCTSPY_ENV: 'production',
    PRODUCTSPY_APP_URL: origin,
    DATABASE_URL: databaseUrl,
    PRODUCTSPY_DB_DRIVER: 'pg',
    PRODUCTSPY_AUTO_MIGRATE: '0',
    PRODUCTSPY_JOB_RUNNER: 'external',
    PRODUCTSPY_DB_POOL_MAX: '3',
    PRODUCTSPY_WORKER_CONCURRENCY: '1',
    PRODUCTSPY_ARCHIVE_SECRET: randomBytes(48).toString('hex'),
    AI_MODE: 'mock',
    AI_API_KEY: '',
    AI_BASE_URL: 'https://ai-disabled.example.invalid/v1',
    STRIPE_SECRET_KEY: '',
    STRIPE_PRICE_PRO: '',
    STRIPE_WEBHOOK_SECRET: '',
    PRODUCTSPY_ENABLE_LIVE_BILLING: '0',
  };
  const composeEnv = {
    ...process.env,
    POSTGRES_PASSWORD: adminPassword,
    COMPOSE_DISABLE_ENV_FILE: '1',
  };
  const args = [
    'compose',
    '--project-name',
    project,
    '--env-file',
    environmentFile,
    '-f',
    resolve('compose.yaml'),
    '-f',
    overrideFile,
  ];
  const compose = (tail, extraEnv = {}, timeout = 90_000) =>
    docker([...args, ...tail], { ...composeEnv, ...extraEnv }, timeout);
  const report = {
    status: 'FAIL',
    runId,
    revision,
    startedAt: new Date().toISOString(),
    checks: [],
    scope:
      'Original Compose services on an isolated local Linux CI daemon; synthetic accounts, Mock AI, no cloud deployment or real TLS',
  };
  let resourcesStarted = false;
  let failure;

  async function owned(type, id) {
    const format = type === 'container' ? '.Config.Labels' : '.Labels';
    const labels = JSON.parse(
      await docker([
        type === 'container' ? 'inspect' : type,
        ...(type === 'container' ? [] : ['inspect']),
        '--format',
        `{{json ${format}}}`,
        id,
      ]),
    );
    validateOwnership(labels, project, runId);
  }

  async function resourceIds(type) {
    const command = type === 'container' ? ['ps', '-a'] : [type, 'ls'];
    const output = await docker([
      ...command,
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      type === 'container' ? '{{.ID}}' : '{{.Name}}',
    ]);
    return output ? output.split('\n') : [];
  }

  async function verifyResources() {
    const result = {};
    for (const type of ['container', 'network', 'volume']) {
      result[type] = await resourceIds(type);
      for (const id of result[type]) await owned(type, id);
    }
    return result;
  }

  async function serviceId(service) {
    const id = await compose(['ps', '-q', service]);
    assert(/^[a-f0-9]{64}$/.test(id), 'Expected one running Compose service container.');
    await owned('container', id);
    return id;
  }

  async function workerRun(name, command, extraEnv = {}) {
    return compose(
      [
        'run',
        '--rm',
        '--no-deps',
        '--pull',
        'never',
        '--name',
        `${project}-${name}`,
        '--label',
        `${markerKey}=${runId}`,
        ...Object.keys(extraEnv).flatMap((key) => ['-e', key]),
        'worker',
        ...command,
      ],
      extraEnv,
    );
  }

  async function baseUrl() {
    const web = await serviceId('web');
    const published = JSON.parse(
      await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', web]),
    );
    const values = published['3000/tcp'];
    assert.equal(values.length, 1, 'Only one web host binding allowed.');
    assert.equal(values[0].HostIp, '127.0.0.1', 'Actual web binding escaped loopback.');
    assert(
      /^\d+$/.test(values[0].HostPort) && Number(values[0].HostPort) > 0,
      'Dynamic web port missing.',
    );
    return `http://127.0.0.1:${values[0].HostPort}`;
  }

  try {
    assert.equal(
      await docker(['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}']),
      'unix:///var/run/docker.sock',
      'Only the local CI Docker daemon is allowed.',
    );
    const version = await docker(['compose', 'version', '--short']);
    const parts = version
      .replace(/^v/, '')
      .match(/^(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number);
    assert(
      parts &&
        (parts[0] > 2 || (parts[0] === 2 && (parts[1] > 24 || (parts[1] === 24 && parts[2] >= 4)))),
      'Docker Compose >=2.24.4 is required for safe env_file replacement.',
    );
    report.composeVersion = version;
    report.sourceComposeSha256 = sha256(await readFile(resolve('compose.yaml')));
    report.images = [];
    for (const image of Object.values(images)) {
      const metadata = (
        await docker([
          'image',
          'inspect',
          '--format',
          '{{.Id}}\n{{.Config.User}}\n{{index .Config.Labels "org.opencontainers.image.revision"}}',
          image,
        ])
      ).split('\n');
      assert(/^sha256:[a-f0-9]{64}$/.test(metadata[0]), 'Local business image required.');
      assert.equal(metadata[1], 'node', 'Business images must run as non-root node.');
      assert.equal(metadata[2], revision, 'Business image does not match this checkout.');
      report.images.push({ image, id: metadata[0], revision, user: metadata[1] });
    }
    await writeFile(
      environmentFile,
      `${Object.entries(appEnv)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { mode: 0o600 },
    );
    await writeFile(overrideFile, composeOverride(environmentFile, runId), { mode: 0o600 });
    validateModel(JSON.parse(await compose(['config', '--format', 'json'])), {
      project,
      runId,
      databaseUrl,
    });
    for (const type of ['container', 'network', 'volume'])
      assert.equal(
        (await resourceIds(type)).length,
        0,
        'Isolated project collision; refusing reuse.',
      );
    report.checks.push(
      'original compose.yaml merged with private test env only; no production env_file or host DB port',
    );
    // Only the official database image may be pulled. Business images always use --pull never.
    try {
      await docker(['image', 'inspect', '--format', '{{.Id}}', 'postgres:17-bookworm']);
    } catch {
      await docker(['pull', 'postgres:17-bookworm'], process.env, 180_000);
    }
    resourcesStarted = true;
    await compose([
      'up',
      '-d',
      '--no-build',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      '90',
      'db',
    ]);
    await verifyResources();
    const firstDb = await serviceId('db');
    assert.equal(
      await docker(['inspect', '--format', '{{len .HostConfig.PortBindings}}', firstDb]),
      '0',
      'Database exposes a host port.',
    );
    await workerRun(
      'migrate',
      ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/saas/migrate.ts'],
      { DATABASE_URL: adminUrl },
    );
    await workerRun(
      'grant',
      [
        'node',
        '--input-type=module',
        '-e',
        `
      import pg from './apps/web/node_modules/pg/lib/index.js';
      const client=new pg.Client({connectionString:process.env.DATABASE_URL});
      await client.connect();
      try {
        const password=process.env.PRODUCTSPY_COMPOSE_APP_PASSWORD;
        if(!/^[a-f0-9]{64}$/.test(password)) throw new Error('Synthetic password invalid');
        await client.query("CREATE ROLE productspy_app LOGIN PASSWORD '"+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS");
        await client.query('GRANT CONNECT ON DATABASE productspy TO productspy_app; GRANT USAGE ON SCHEMA public TO productspy_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO productspy_app');
      } finally {await client.end()}
    `,
      ],
      { DATABASE_URL: adminUrl, PRODUCTSPY_COMPOSE_APP_PASSWORD: appPassword },
    );
    const roleProof = JSON.parse(
      await workerRun('role-check', [
        'node',
        '--input-type=module',
        '-e',
        `
      import pg from './apps/web/node_modules/pg/lib/index.js';
      import {randomUUID} from 'node:crypto';
      const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect();
      try {
        const proof={
        role:(await c.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0],
        address:(await c.query('SELECT inet_server_addr()::text AS address')).rows[0].address,
        tenantTables:(await c.query("SELECT relname AS name,relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname",[${JSON.stringify(tenantTables)}])).rows,
        channelTables:(await c.query("SELECT relname AS name,relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE relnamespace='public'::regnamespace AND relname='ai_channel_settings'")).rows,
        channelPolicies:(await c.query("SELECT policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='ai_channel_settings' ORDER BY policyname")).rows,
        unscoped:(await c.query('SELECT count(*)::integer AS n FROM workspace_documents')).rows[0].n
        };
        // This isolated canary exists only inside a rolled-back transaction. A nonempty
        // row makes the unmarked-read proof meaningful even on the fresh CI database.
        const userId=randomUUID();
        await c.query('BEGIN');
        try {
          await c.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[userId,'compose-rls-'+userId+'@example.invalid','synthetic-no-login']);
          await c.query("SELECT set_config('app.ai_configuration_access','trusted-server',true)");
          await c.query("INSERT INTO ai_channel_settings(id,revision,encrypted_payload,updated_by) VALUES('global',1,$1,$2)",['synthetic-compose-rls-canary',userId]);
          const count=async()=>(await c.query('SELECT count(*)::integer AS n FROM ai_channel_settings')).rows[0].n;
          const trusted=await count();
          await c.query("SELECT set_config('app.ai_configuration_access','',true)");
          const unscoped=await count();
          await c.query("SELECT set_config('app.user_id',$1,true)",[userId]);
          const userScoped=await count();
          await c.query('SAVEPOINT unmarked_write');
          let writeError;
          try {
            await c.query("INSERT INTO ai_channel_settings(id,revision,encrypted_payload,updated_by) VALUES('global',1,$1,$2)",['synthetic-unmarked-write',userId]);
          } catch(error) {writeError=error.code}
          await c.query('ROLLBACK TO SAVEPOINT unmarked_write');
          proof.channelProbe={trusted,unscoped,userScoped,writeError};
        } finally {await c.query('ROLLBACK')}
        console.log(JSON.stringify(proof));
      } finally {await c.end()}
    `,
      ]),
    );
    validateRoleProof(roleProof);
    report.checks.push(
      'db service DNS/internal network, migrations, restricted app role and all six named tenant FORCE RLS tables',
      'global AI settings FORCE RLS and internal-only read/write policy; transactional canary hidden from unmarked and user-scoped app role',
    );
    await compose([
      'up',
      '-d',
      '--no-build',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      '90',
      'web',
    ]);
    await verifyResources();
    const firstWeb = await serviceId('web');
    let base = await baseUrl();
    const password = `Synthetic-compose-${randomBytes(24).toString('hex')}`;
    const owner = {
      email: `compose-owner-${runId}@example.invalid`,
      name: 'Synthetic Compose Owner',
      password,
    };
    const ownerCookie = cookie((await request(base, '/api/auth/register', 'POST', owner)).cookie);
    const product = (
      await request(
        base,
        '/api/products',
        'POST',
        {
          source: 'amazon',
          sourceId: 'B055555555',
          url: 'https://www.amazon.com/dp/B055555555',
          title: 'Synthetic Compose persistence product',
          images: [],
          videos: [],
          bulletPoints: ['Synthetic fixture, Mock AI only'],
        },
        ownerCookie,
      )
    ).data;
    const jobId = randomUUID();
    assert.equal(
      (
        await request(
          base,
          '/api/jobs',
          'POST',
          { endpoint: '/api/analyze-product', input: { requestId: jobId, product } },
          ownerCookie,
          202,
        )
      ).data.status,
      'queued',
    );
    assert.equal(
      (await request(base, `/api/jobs/${jobId}`, 'GET', undefined, ownerCookie)).data.status,
      'queued',
    );
    report.checks.push(
      'web registration and product persistence; job stays queued before worker service starts',
    );
    await compose([
      'up',
      '-d',
      '--no-build',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      '90',
      'worker',
    ]);
    await verifyResources();
    const worker = await serviceId('worker');
    for (const id of [firstDb, firstWeb, worker])
      assert.equal(
        await docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', id]),
        `${project}_default`,
        'Service is outside the original Compose network.',
      );
    let completed = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = (await request(base, `/api/jobs/${jobId}`, 'GET', undefined, ownerCookie)).data
        .status;
      if (status === 'succeeded') {
        completed = true;
        break;
      }
      assert(['queued', 'running'].includes(status), 'Mock worker job failed or was interrupted.');
      await wait(1000);
    }
    assert(completed, 'Original worker service did not finish the queued Mock task.');
    assert.equal(
      await docker(['inspect', '--format', '{{.State.Status}}', worker]),
      'running',
      'Original continuous worker process must still run.',
    );
    const productPath = `/api/products/${encodeURIComponent(product.id)}`;
    const saved = (await request(base, productPath, 'GET', undefined, ownerCookie)).data;
    const history = (
      await request(base, `${productPath}/analysis-history`, 'GET', undefined, ownerCookie)
    ).data;
    assert(
      saved.aiAnalysis?.hooks?.length >= 5 && history.length >= 1,
      'Mock analysis/history was not saved.',
    );
    const productSha = sha256(JSON.stringify(saved));
    const historySha = sha256(JSON.stringify(history));
    report.checks.push(
      'original independent continuous worker command consumes queued task and persists analysis/history',
    );
    await verifyResources();
    await compose(['stop', '-t', '10', 'worker', 'web', 'db']);
    await compose(['rm', '-f', 'worker', 'web', 'db']);
    await owned('volume', `${project}_postgres-data`);
    await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90']);
    await verifyResources();
    assert.notEqual(await serviceId('db'), firstDb, 'Database container was not recreated.');
    assert.notEqual(await serviceId('web'), firstWeb, 'Web container was not recreated.');
    base = await baseUrl();
    const freshCookie = cookie(
      (await request(base, '/api/auth/login', 'POST', { email: owner.email, password })).cookie,
    );
    assert.equal(
      sha256(
        JSON.stringify((await request(base, productPath, 'GET', undefined, freshCookie)).data),
      ),
      productSha,
      'Product changed after Compose recreation.',
    );
    assert.equal(
      sha256(
        JSON.stringify(
          (await request(base, `${productPath}/analysis-history`, 'GET', undefined, freshCookie))
            .data,
        ),
      ),
      historySha,
      'History changed after Compose recreation.',
    );
    const otherCookie = cookie(
      (
        await request(base, '/api/auth/register', 'POST', {
          email: `compose-other-${runId}@example.invalid`,
          name: 'Synthetic Compose Other',
          password,
        })
      ).cookie,
    );
    assert.equal(
      (await request(base, '/api/products', 'GET', undefined, otherCookie)).data.length,
      0,
    );
    for (const path of [productPath, `${productPath}/analysis-history`, `/api/jobs/${jobId}`])
      await request(base, path, 'GET', undefined, otherCookie, 404);
    report.productSha256 = productSha;
    report.historySha256 = historySha;
    report.checks.push(
      'web and database containers recreated, original named volume preserved, fresh login and identical record checksums',
    );
    report.checks.push(
      'second account empty library and product/history/job 404 isolation after recreation',
    );
    report.status = 'PASS';
  } catch (error) {
    failure = error;
    report.error =
      error instanceof assert.AssertionError
        ? error.message.split('\n')[0]
        : 'Compose verification failed.';
    if (error.summary) report.errorSummary = error.summary;
  } finally {
    report.cleanup = { containers: 0, networks: 0, volumes: 0, privateEnvironment: false };
    if (resourcesStarted) {
      try {
        const resources = await verifyResources();
        for (const [type, flag] of [
          ['container', 'containers'],
          ['network', 'networks'],
          ['volume', 'volumes'],
        ]) {
          for (const id of resources[type]) {
            await owned(type, id);
            await docker(type === 'container' ? ['rm', '--force', id] : [type, 'rm', id]);
            report.cleanup[flag] += 1;
          }
          assert.equal((await resourceIds(type)).length, 0, 'Owned resource cleanup incomplete.');
        }
      } catch {
        report.status = 'FAIL';
        failure ||= new Error('Could not safely clean up isolated Compose resources.');
      }
    }
    try {
      // Delete only the exact files this run created; never recurse over a computed path.
      await rm(environmentFile, { force: true });
      await rm(overrideFile, { force: true });
      await rmdir(privateDirectory);
      report.cleanup.privateEnvironment = true;
    } catch {
      report.status = 'FAIL';
      failure ||= new Error('Private test environment cleanup failed.');
    }
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
  if (failure) throw new Error('Compose verification failed; inspect the sanitized local report.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch((error) => {
    console.error(
      error instanceof assert.AssertionError
        ? error.message.split('\n')[0]
        : 'Compose verification failed; credentials and raw logs are suppressed.',
    );
    process.exitCode = 1;
  });
