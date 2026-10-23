import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from '../../apps/web/node_modules/pg/lib/index.js';

// This verifier never dumps the database supplied in the environment. It creates two
// empty, uniquely named databases, seeds synthetic data through real application routes,
// and owns their cleanup. Application verification uses in-process handlers, not HTTP.
const execute = promisify(execFile);
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const tenantTables = [
  'workspace_documents',
  'subscriptions',
  'usage_events',
  'jobs',
  'capture_events',
  'audit_events',
];

function localTestURL(name) {
  const value = process.env[name];
  assert(value, `Set ${name} explicitly for a temporary loopback PostgreSQL test cluster.`);
  const url = new URL(value);
  assert(['postgres:', 'postgresql:'].includes(url.protocol), `${name}: PostgreSQL URL required.`);
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    `${name}: only a literal loopback test cluster is allowed.`,
  );
  assert(!url.search && !url.hash, `${name}: URL options and fragments are forbidden.`);
  assert(/^\/[A-Za-z0-9_]+$/.test(url.pathname), `${name}: explicit database name required.`);
  assert(url.username, `${name}: explicit database role required.`);
  // Do not let a hosts-file entry for localhost redirect a nominally local test.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

function childEnvironment(url) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PG')),
  );
  return {
    ...env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: '-c timezone=UTC',
  };
}

async function run(command, args, env) {
  try {
    return await execute(command, args, {
      env,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    // Do not forward environment, command objects, connection URLs, or provider secrets.
    const detail = error.stderr ? String(error.stderr).slice(-3000) : 'process failed';
    throw new Error(`${command.split(/[\\/]/).at(-1)}: ${detail}`);
  }
}

async function snapshot(client) {
  const tables = (
    await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((row) => row.tablename);
  const result = {};
  for (const table of tables) {
    const record = await client.query(
      `SELECT count(*)::integer AS count, COALESCE(jsonb_agg(record ORDER BY record::text),'[]'::jsonb)::text AS payload FROM (SELECT to_jsonb(t) AS record FROM public.${identifier(table)} t) records`,
    );
    result[table] = {
      rows: record.rows[0].count,
      sha256: hash(record.rows[0].payload),
    };
  }
  return result;
}

async function policies(client) {
  return (
    await client.query(
      `SELECT t.relname AS table_name,t.relrowsecurity AS enabled,t.relforcerowsecurity AS forced,
         p.polname,p.polcmd,p.polpermissive,pg_get_expr(p.polqual,p.polrelid) AS using_expression,
         pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
       FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
       LEFT JOIN pg_policy p ON p.polrelid=t.oid
       WHERE n.nspname='public' AND t.relkind='r' ORDER BY t.relname,p.polname`,
    )
  ).rows;
}

async function verifyApplication(url, action, credentials, expected) {
  const result = await run(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/saas/verify-restored-app.ts')],
    {
      ...childEnvironment(url),
      DATABASE_URL: url.href,
      PRODUCTSPY_RESTORED_APP_VERIFY: '1',
      PRODUCTSPY_RECOVERY_ACTION: action,
      PRODUCTSPY_RECOVERY_CREDENTIALS: JSON.stringify(credentials),
      PRODUCTSPY_RECOVERY_EXPECTED: JSON.stringify(expected ?? []),
      AI_MODE: 'mock',
      AI_API_KEY: '',
      STRIPE_SECRET_KEY: '',
      STRIPE_PRICE_PRO: '',
      STRIPE_WEBHOOK_SECRET: '',
      PRODUCTSPY_ENABLE_LIVE_BILLING: '0',
    },
  );
  return JSON.parse(result.stdout);
}

async function tenantCounts(client, users) {
  const counts = {};
  for (const user of users) {
    counts[user] = {};
    for (const table of tenantTables) {
      const result = await client.query(
        `SELECT count(*)::integer AS count FROM ${identifier(table)} WHERE user_id=$1`,
        [user],
      );
      counts[user][table] = result.rows[0].count;
      assert(counts[user][table] > 0, `The source application did not exercise ${table}.`);
    }
  }
  return counts;
}

async function verifyRLS(client, users, expectedCounts) {
  const counts = {};
  for (const table of tenantTables) {
    assert.equal(
      (await client.query(`SELECT count(*)::integer AS count FROM ${identifier(table)}`)).rows[0]
        .count,
      0,
      `Unscoped app role can read ${table}.`,
    );
  }
  for (const user of users) {
    await client.query("SELECT set_config('app.user_id',$1,false)", [user]);
    counts[user] = {};
    for (const table of tenantTables) {
      const rows = (await client.query(`SELECT user_id FROM ${identifier(table)}`)).rows;
      const expected = expectedCounts[user][table];
      assert.equal(rows.length, expected, `Missing restored rows in ${table}.`);
      assert(
        rows.every((row) => row.user_id === user),
        `${table} leaked another tenant.`,
      );
      counts[user][table] = rows.length;
      assert.equal(
        (
          await client.query(
            `SELECT count(*)::integer AS count FROM ${identifier(table)} WHERE user_id<>$1`,
            [user],
          )
        ).rows[0].count,
        0,
        `${table} ignored tenant scope.`,
      );
    }
  }
  // A transaction makes a surprising successful write reversible, while still failing verification.
  await client.query('BEGIN');
  let rejected = false;
  try {
    await client.query(
      "INSERT INTO audit_events(id,user_id,action) VALUES($1,$2,'forbidden-cross-tenant-probe')",
      [randomUUID(), users[0]],
    );
  } catch (error) {
    if (error.code !== '42501') throw error;
    rejected = true;
  } finally {
    await client.query('ROLLBACK');
  }
  assert(rejected, 'Restored app role can write into another tenant.');
  return { unscopedRows: 0, crossTenantReadRows: 0, crossTenantWriteRejected: true, counts };
}

async function main() {
  assert.equal(
    process.env.PRODUCTSPY_LOGICAL_RECOVERY_ALLOW_CREATE,
    '1',
    'Set PRODUCTSPY_LOGICAL_RECOVERY_ALLOW_CREATE=1 to create isolated temporary test databases.',
  );
  const adminURL = localTestURL('PRODUCTSPY_TEST_ADMIN_DATABASE_URL');
  const appURL = localTestURL('PRODUCTSPY_TEST_DATABASE_URL');
  assert.equal(
    adminURL.hostname,
    appURL.hostname,
    'Test roles must use the same loopback cluster.',
  );
  assert.equal(adminURL.port || '5432', appURL.port || '5432', 'Test cluster ports differ.');
  const appRole = decodeURIComponent(appURL.username);
  assert.notEqual(
    appRole,
    decodeURIComponent(adminURL.username),
    'Use a separate restricted app role.',
  );
  const pgBin = process.env.PRODUCTSPY_PG_BIN;
  assert(pgBin, 'Set PRODUCTSPY_PG_BIN to an existing directory with pg_dump and pg_restore.');
  const executable = (name) =>
    resolve(pgBin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  const dumpVersion = (
    await run(executable('pg_dump'), ['--version'], childEnvironment(adminURL))
  ).stdout.trim();
  const restoreVersion = (
    await run(executable('pg_restore'), ['--version'], childEnvironment(adminURL))
  ).stdout.trim();
  const runId = randomUUID().replaceAll('-', '');
  const sourceName = `productspy_logical_source_${runId}`;
  const targetName = `productspy_logical_target_${runId}`;
  const marker = `ProductSpy synthetic logical recovery ${runId}`;
  const directory = resolve('.test-data/saas/logical-recovery', runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dumpFile = join(directory, 'synthetic-backup.dump');
  const reportFile = join(directory, 'report.json');
  const admin = new pg.Client({ connectionString: adminURL.href, connectionTimeoutMillis: 5000 });
  const clients = [];
  const created = new Set();
  const report = {
    status: 'FAIL',
    runId,
    fixture:
      'Synthetic accounts and valid business models created through actual application routes; Mock only, no real user data or external AI/payment calls',
    scope: 'Local loopback logical backup/restore; no cloud, TLS, PITR, or production verification',
    sourceDatabase: sourceName,
    targetDatabase: targetName,
    pgDump: dumpVersion,
    pgRestore: restoreVersion,
    startedAt: new Date().toISOString(),
  };
  let failure;
  try {
    await admin.connect();
    const adminState = (
      await admin.query(
        'SELECT rolsuper,rolbypassrls,rolcreatedb FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    assert(adminState.rolsuper || adminState.rolcreatedb, 'Test administrator needs CREATEDB.');
    assert(
      adminState.rolsuper || adminState.rolbypassrls,
      'Test backup administrator must bypass FORCE RLS to back up both synthetic tenants.',
    );
    const role = (
      await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1', [appRole])
    ).rows[0];
    assert(
      role && !role.rolsuper && !role.rolbypassrls,
      'App role must be NOSUPERUSER NOBYPASSRLS.',
    );
    report.serverVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
    for (const name of [sourceName, targetName]) {
      assert(/^productspy_logical_(source|target)_[0-9a-f]{32}$/.test(name));
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
      assert.equal(existing.rowCount, 0, 'Refusing to overwrite an existing database.');
      await admin.query(`CREATE DATABASE ${identifier(name)} TEMPLATE template0`);
      created.add(name);
      await admin.query(`COMMENT ON DATABASE ${identifier(name)} IS '${marker}'`);
    }
    const sourceURL = new URL(adminURL);
    sourceURL.pathname = `/${sourceName}`;
    const targetURL = new URL(adminURL);
    targetURL.pathname = `/${targetName}`;
    await run(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/saas/migrate.ts')],
      {
        ...childEnvironment(sourceURL),
        PRODUCTSPY_MODE: 'saas',
        PRODUCTSPY_DB_DRIVER: 'pg',
        PRODUCTSPY_AUTO_MIGRATE: '0',
        DATABASE_URL: sourceURL.href,
      },
    );
    const connect = async (url) => {
      const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
      await client.connect();
      clients.push(client);
      await client.query("SET timezone='UTC'");
      return client;
    };
    const source = await connect(sourceURL);
    const target = await connect(targetURL);
    assert.equal(
      (await target.query("SELECT 1 FROM pg_tables WHERE schemaname='public'")).rowCount,
      0,
      'Restore target is not empty.',
    );
    await source.query(`GRANT USAGE ON SCHEMA public TO ${identifier(appRole)}`);
    await source.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${identifier(appRole)}`,
    );
    const sourceAppURL = new URL(appURL);
    sourceAppURL.pathname = `/${sourceName}`;
    const credentials = [0, 1].map((index) => ({
      email: `logical-recovery-${index}-${runId}@example.invalid`,
      password: `Synthetic-recovery-${randomBytes(32).toString('hex')}`,
    }));
    const sourceApplication = await verifyApplication(sourceAppURL, 'seed', credentials);
    const users = sourceApplication.accounts.map((account) => account.userId);
    assert.equal(users.length, 2, 'The source application did not create two synthetic users.');
    const expectedCounts = await tenantCounts(source, users);
    const before = await snapshot(source);
    const beforePolicies = await policies(source);
    for (const table of tenantTables) {
      const policy = beforePolicies.find((item) => item.table_name === table);
      assert(policy?.enabled && policy.forced, `Source ${table} must have FORCE RLS.`);
    }
    await run(
      executable('pg_dump'),
      ['--format=custom', '--no-owner', '--no-acl', '--no-password', '--file', dumpFile],
      childEnvironment(sourceURL),
    );
    await chmod(dumpFile, 0o600);
    const dump = await readFile(dumpFile);
    assert.equal(dump.subarray(0, 5).toString(), 'PGDMP', 'Not a PostgreSQL custom-format dump.');
    await run(
      executable('pg_restore'),
      [
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        '--no-password',
        '--dbname',
        targetName,
        dumpFile,
      ],
      childEnvironment(targetURL),
    );
    const restored = await snapshot(target);
    assert.deepEqual(restored, before, 'Restored SQL table counts or content checksums differ.');
    assert.deepEqual(await policies(target), beforePolicies, 'Restored RLS definitions differ.');
    await target.query(`GRANT USAGE ON SCHEMA public TO ${identifier(appRole)}`);
    await target.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${identifier(appRole)}`,
    );
    const restoredAppURL = new URL(appURL);
    restoredAppURL.pathname = `/${targetName}`;
    const restoredApp = await connect(restoredAppURL);
    const owner = (
      await restoredApp.query(
        "SELECT current_user AS role,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='workspace_documents'::regclass",
      )
    ).rows[0];
    assert.notEqual(owner.role, owner.owner, 'Restricted app role must not own restored tables.');
    report.rls = await verifyRLS(restoredApp, users, expectedCounts);
    // Re-run checksums after the rejected-write probe, proving it left restored data unchanged.
    assert.deepEqual(await snapshot(target), before);
    const originalSessions = (await target.query('SELECT * FROM sessions ORDER BY token_hash'))
      .rows;
    const restoredApplication = await verifyApplication(
      restoredAppURL,
      'read',
      credentials,
      sourceApplication.accounts,
    );
    const afterApplication = await snapshot(target);
    for (const table of Object.keys(before)) {
      if (table !== 'sessions' && table !== 'api_rate_limits')
        assert.deepEqual(
          afterApplication[table],
          before[table],
          `Application reads mutated ${table}.`,
        );
    }
    assert.equal(
      afterApplication.sessions.rows,
      before.sessions.rows + 2,
      'Restored logins must add exactly two sessions.',
    );
    assert.notEqual(
      afterApplication.api_rate_limits.sha256,
      before.api_rate_limits.sha256,
      'Application authentication must update rate-limit counters.',
    );
    const preservedSessions = (
      await target.query(
        'SELECT * FROM sessions WHERE token_hash=ANY($1::text[]) ORDER BY token_hash',
        [originalSessions.map((session) => session.token_hash)],
      )
    ).rows;
    assert.deepEqual(
      preservedSessions,
      originalSessions,
      'Existing restored sessions were changed.',
    );
    report.applicationRecovery = {
      source: sourceApplication,
      restored: restoredApplication,
      sqlChecksumVerifiedBeforeApplicationWrites: true,
      postApplicationWrites: {
        sessionsAdded: 2,
        originalSessionsUnchanged: true,
        authAndApiRateLimitsUpdated: true,
        allOtherTablesUnchanged: true,
      },
    };
    report.tables = restored;
    report.tablesSnapshot =
      'After SQL restore and rolled-back RLS write probe, before restored-application login writes';
    report.rlsPolicySha256 = hash(JSON.stringify(beforePolicies));
    report.dumpSha256 = hash(dump);
    report.dumpBytes = dump.length;
    report.status = 'PASS';
  } catch (error) {
    failure = error;
    report.error = error instanceof Error ? error.message : 'Logical recovery verification failed.';
  } finally {
    for (const client of clients.reverse()) await client.end();
    report.cleanup = [];
    for (const name of [...created].reverse()) {
      try {
        const metadata = (
          await admin.query(
            "SELECT shobj_description(oid,'pg_database') AS marker,pg_get_userbyid(datdba)=current_user AS owned FROM pg_database WHERE datname=$1",
            [name],
          )
        ).rows[0];
        assert(
          metadata?.owned && metadata.marker === marker,
          'Temporary database ownership changed.',
        );
        await admin.query(`DROP DATABASE ${identifier(name)}`);
        report.cleanup.push({ database: name, dropped: true });
      } catch {
        report.cleanup.push({ database: name, dropped: false });
        if (!failure) failure = new Error('Could not safely clean up a temporary test database.');
        report.status = 'FAIL';
      }
    }
    await admin.end();
    report.finishedAt = new Date().toISOString();
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, report: reportFile }));
  }
  if (failure) throw failure;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Logical recovery verification failed.');
  process.exitCode = 1;
});
