import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import pg from '../../apps/web/node_modules/pg/lib/index.js';
import { validateOwnedWindowsCluster } from './verify-windows-postgres-validation.mjs';

// A portable binary directory is supplied explicitly. Never installs a service,
// discovers credentials, or connects to an existing database cluster.
const { values } = parseArgs({
  options: {
    'pg-bin': { type: 'string' },
    standalone: { type: 'boolean', default: false },
  },
});
assert.equal(process.platform, 'win32', 'This portable-cluster verifier is for Windows.');
assert(values['pg-bin'] && isAbsolute(values['pg-bin']), 'Supply an absolute --pg-bin directory.');
const pgBin = resolve(values['pg-bin']);
const workspace = resolve(import.meta.dirname, '../..');
const evidenceRoot = resolve(workspace, '.test-data/saas/windows-postgres');
const runId = randomUUID();
const directory = resolve(evidenceRoot, runId);
const cluster = join(directory, 'cluster');
const passwordFile = join(directory, 'admin-password.txt');
const markerFile = join(directory, 'owned-cluster.json');
const reportFile = join(directory, 'report.json');
const adminName = 'productspy_verify_admin';
const appName = 'productspy_verify_app';
const databaseName = `productspy_verify_${runId.replaceAll('-', '')}`;
const adminPassword = randomBytes(32).toString('hex');
const appPassword = randomBytes(32).toString('hex');
const execute = promisify(execFile);
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const report = {
  runId,
  startedAt: new Date().toISOString(),
  status: 'RUNNING',
  nodeVersion: process.version,
  postgresHostAuthentication: 'scram-sha-256',
  scope: 'Temporary loopback PostgreSQL, synthetic accounts, Mock AI; no Windows service.',
  binaryDirectory: pgBin,
  commands: [],
  cleanup: {},
};
let startAttempted = false;
let failure;

function sanitize(value) {
  return String(value)
    .replaceAll(adminPassword, '[REDACTED]')
    .replaceAll(appPassword, '[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/g, '[REDACTED_DATABASE_URL]');
}
async function command(name, executable, args, env, timeout = 120_000) {
  console.log(`[portable PostgreSQL] ${name}`);
  const began = Date.now();
  try {
    // pg_ctl exits after readiness, but its daemon can inherit execFile's pipes
    // on Windows and keep the callback waiting until PostgreSQL stops.
    const result =
      name === 'start'
        ? await new Promise((complete, reject) => {
            const child = spawn(executable, args, {
              cwd: workspace,
              env,
              windowsHide: true,
              stdio: 'ignore',
            });
            const timer = setTimeout(() => {
              child.kill();
              reject(new Error('PostgreSQL startup timed out.'));
            }, timeout);
            child.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once('exit', (code) => {
              clearTimeout(timer);
              if (code === 0)
                complete({ stdout: 'pg_ctl readiness passed; see postgres.log.', stderr: '' });
              else reject(new Error(`pg_ctl startup exited ${code}.`));
            });
          })
        : await execute(executable, args, {
            cwd: workspace,
            env,
            windowsHide: true,
            timeout,
            maxBuffer: 8 * 1024 * 1024,
          });
    const output = sanitize(`${result.stdout}\n${result.stderr}`).trim();
    await writeFile(join(directory, `${name}.log`), `${output}\n`, { mode: 0o600 });
    report.commands.push({ name, status: 'PASS', elapsedMs: Date.now() - began, output });
    return output;
  } catch (error) {
    const output = sanitize(`${error.stdout ?? ''}\n${error.stderr ?? ''}`).trim();
    await writeFile(join(directory, `${name}.log`), `${output}\n`, { mode: 0o600 });
    report.commands.push({
      name,
      status: 'FAIL',
      elapsedMs: Date.now() - began,
      output,
      code: error.code,
    });
    throw new Error(`${name} failed (${error.code ?? 'unknown'}). See its sanitized log.`);
  }
}
async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((complete, reject) =>
    probe.close((error) => (error ? reject(error) : complete())),
  );
  return port;
}
function databaseURL(username, password, port, database) {
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = username;
  url.password = password;
  return url.href;
}

await mkdir(directory, { recursive: true });
await writeFile(markerFile, JSON.stringify({ runId, cluster }), { mode: 0o600 });
try {
  for (const binary of ['initdb.exe', 'pg_ctl.exe', 'pg_dump.exe', 'pg_restore.exe'])
    await access(join(pgBin, binary));
  const port = await freePort();
  report.port = port;
  report.version = await command(
    'version',
    join(pgBin, 'postgres.exe'),
    ['--version'],
    process.env,
  );
  await writeFile(passwordFile, `${adminPassword}\n`, { mode: 0o600 });
  await command(
    'initdb',
    join(pgBin, 'initdb.exe'),
    [
      '-D',
      cluster,
      '--username',
      adminName,
      '--pwfile',
      passwordFile,
      '--encoding=UTF8',
      '--locale=C',
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
    ],
    process.env,
  );
  startAttempted = true;
  await command(
    'start',
    join(pgBin, 'pg_ctl.exe'),
    [
      '-D',
      cluster,
      '-w',
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port}`,
      'start',
    ],
    process.env,
  );
  const adminURL = databaseURL(adminName, adminPassword, port, databaseName);
  const appURL = databaseURL(appName, appPassword, port, databaseName);
  const admin = new pg.Client({
    connectionString: databaseURL(adminName, adminPassword, port, 'postgres'),
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${identifier(databaseName)}`);
    await admin.query(
      `CREATE ROLE ${identifier(appName)} LOGIN PASSWORD ${literal(appPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  } finally {
    await admin.end();
  }
  const env = {
    ...process.env,
    PRODUCTSPY_MODE: 'saas',
    PRODUCTSPY_ENV: 'test',
    PRODUCTSPY_DB_DRIVER: 'pg',
    PRODUCTSPY_AUTO_MIGRATE: '0',
    PRODUCTSPY_DB_POOL_MAX: '3',
    PRODUCTSPY_WORKER_CONCURRENCY: '1',
    PRODUCTSPY_TEST_DATABASE_URL: appURL,
    PRODUCTSPY_TEST_ADMIN_DATABASE_URL: adminURL,
    PRODUCTSPY_PG_BIN: pgBin,
    PRODUCTSPY_LOGICAL_RECOVERY_ALLOW_CREATE: '1',
    AI_MODE: 'mock',
    AI_API_KEY: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    PRODUCTSPY_ENABLE_LIVE_BILLING: '0',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  await command(
    'migrate',
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/saas/migrate.ts'],
    { ...env, NODE_ENV: 'production', PRODUCTSPY_ENV: 'production', DATABASE_URL: adminURL },
  );
  await command(
    'migrate-repeat',
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/saas/migrate.ts'],
    { ...env, NODE_ENV: 'production', PRODUCTSPY_ENV: 'production', DATABASE_URL: adminURL },
  );
  const grant = new pg.Client({ connectionString: adminURL, connectionTimeoutMillis: 10_000 });
  await grant.connect();
  try {
    await grant.query(
      `GRANT CONNECT ON DATABASE ${identifier(databaseName)} TO ${identifier(appName)}`,
    );
    await grant.query(`GRANT USAGE ON SCHEMA public TO ${identifier(appName)}`);
    await grant.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${identifier(appName)}`,
    );
    const role = (
      await grant.query(
        'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1',
        [appName],
      )
    ).rows[0];
    assert.deepEqual(role, {
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    report.applicationRole = role;
  } finally {
    await grant.end();
  }
  const productionProbe = `
    import assert from 'node:assert/strict';
    import { ensureDatabase, closeDatabase } from './apps/web/src/lib/saas/database';
    async function main() {
      let failure;
      try { await ensureDatabase(); } catch (error) { failure = error; }
      finally { await closeDatabase(); }
      if (process.env.PRODUCTSPY_EXPECT_ROLE === 'accept') assert.equal(failure, undefined);
      else {
        assert(failure instanceof Error, 'Production accepted a privileged role.');
        assert(failure.message.includes('NOSUPERUSER/NOBYPASSRLS'));
      }
      console.log('Production database role: ' + process.env.PRODUCTSPY_EXPECT_ROLE);
    }
    void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  async function probeRole(name, connectionString, expected) {
    await command(
      name,
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', '--eval', productionProbe],
      {
        ...env,
        NODE_ENV: 'production',
        PRODUCTSPY_ENV: 'production',
        DATABASE_URL: connectionString,
        PRODUCTSPY_EXPECT_ROLE: expected,
      },
    );
  }
  await probeRole('production-app-role', appURL, 'accept');
  await probeRole('production-admin-rejected', adminURL, 'reject');
  const concealedAdmin = new URL(adminURL);
  concealedAdmin.searchParams.set('options', `-c role=${appName}`);
  await probeRole('production-concealed-admin-rejected', concealedAdmin.href, 'reject');
  const privileges = new pg.Client({ connectionString: adminURL, connectionTimeoutMillis: 10_000 });
  await privileges.connect();
  try {
    await privileges.query(`ALTER ROLE ${identifier(appName)} BYPASSRLS`);
    try {
      await probeRole('production-bypass-rejected', appURL, 'reject');
    } finally {
      await privileges.query(`ALTER ROLE ${identifier(appName)} NOBYPASSRLS`);
    }
    await privileges.query(`GRANT ${identifier(adminName)} TO ${identifier(appName)}`);
    try {
      await probeRole('production-member-rejected', appURL, 'reject');
    } finally {
      await privileges.query(`REVOKE ${identifier(adminName)} FROM ${identifier(appName)}`);
    }
  } finally {
    await privileges.end();
  }
  await command(
    'postgres-tests',
    process.execPath,
    [
      'scripts/test-unit.mjs',
      'apps/web/src/lib/saas/saas-api.test.ts',
      'apps/web/src/lib/saas/billing.test.ts',
      'apps/web/src/lib/saas/billing-checkout.test.ts',
      'apps/web/src/lib/saas/jobs-pagination.test.ts',
    ],
    { ...env, DATABASE_URL: appURL },
    300_000,
  );
  await command(
    'logical-recovery',
    process.execPath,
    ['scripts/saas/verify-logical-recovery.mjs'],
    env,
    300_000,
  );
  if (values.standalone)
    await command(
      'standalone',
      process.execPath,
      ['scripts/saas/verify-standalone.mjs'],
      { ...env, DATABASE_URL: appURL },
      180_000,
    );
  report.status = 'PASS';
} catch (error) {
  failure = error;
  report.status = 'FAIL';
  report.error = sanitize(error instanceof Error ? error.message : 'Verification failed.');
} finally {
  if (startAttempted) {
    try {
      const status = await execute(join(pgBin, 'pg_ctl.exe'), ['-D', cluster, 'status'], {
        windowsHide: true,
        timeout: 10_000,
      }).catch((error) => {
        if (error.code === 3) return null;
        throw error;
      });
      if (status)
        await command(
          'stop',
          join(pgBin, 'pg_ctl.exe'),
          ['-D', cluster, '-m', 'fast', '-w', 'stop'],
          process.env,
        );
      report.cleanup.clusterStopped = true;
    } catch (error) {
      report.cleanup.clusterStopped = false;
      failure ??= error;
      report.status = 'FAIL';
    }
  }
  await rm(passwordFile, { force: true });
  report.cleanup.passwordFileRemoved = true;
  if (!startAttempted || report.cleanup.clusterStopped) {
    try {
      const marker = JSON.parse(await readFile(markerFile, 'utf8'));
      validateOwnedWindowsCluster(evidenceRoot, directory, cluster, marker, runId);
      await rm(cluster, { recursive: true, force: true });
      report.cleanup.ownedClusterRemoved = true;
    } catch (error) {
      report.cleanup.ownedClusterRemoved = false;
      failure ??= error;
      report.status = 'FAIL';
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify({ status: report.status, report: reportFile, cleanup: report.cleanup }),
  );
}
if (failure) process.exitCode = 1;
