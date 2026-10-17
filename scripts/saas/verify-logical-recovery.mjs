import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from '../../apps/web/node_modules/pg/lib/index.js';

// This verifier never dumps the database supplied in the environment. It creates two
// empty, uniquely named databases, seeds only synthetic records, and owns their cleanup.
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

async function seed(client, users) {
  for (const [index, user] of users.entries()) {
    await client.query('INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,$3,$4)', [
      user,
      `${user}@logical-recovery.example.invalid`,
      hash(`synthetic-not-a-login-password-${user}`),
      `Synthetic recovery tenant ${index + 1}`,
    ]);
    for (const kind of ['web', 'extension']) {
      await client.query(
        "INSERT INTO sessions(token_hash,user_id,kind,extension_origin,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')",
        [
          hash(`synthetic-${kind}-${user}`),
          user,
          kind,
          kind === 'extension' ? `chrome-extension://${'a'.repeat(32)}` : null,
        ],
      );
    }
    await client.query(
      "INSERT INTO extension_codes(code_hash,user_id,origin,expires_at) VALUES($1,$2,$3,now()+interval '2 minutes')",
      [hash(`synthetic-code-${user}`), user, `chrome-extension://${'a'.repeat(32)}`],
    );
    const product = {
      id: 'amazon:B011111111',
      source: 'amazon',
      sourceId: 'B011111111',
      url: 'https://www.amazon.com/dp/B011111111',
      title: `Synthetic logical recovery product for tenant ${index + 1}`,
      images: [],
      videos: [],
      bulletPoints: ['Synthetic SQL recovery fixture; no Amazon request or AI provider call'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      analysisHistory: [{ requestId: `analysis-${user}`, result: { fixture: 'synthetic Mock' } }],
    };
    const documents = {
      'products.json': [product],
      'templates.json': { templates: [{ id: `template-${user}`, name: 'Synthetic recovery' }] },
      'comparisons.json': { comparisons: [{ id: `comparison-${user}`, productIds: [product.id] }] },
      'content-plans.json': {
        plans: [{ id: `content-${user}`, content: 'Synthetic saved content, not real AI output' }],
      },
      'analysis-usage.json': { requests: [{ requestId: `analysis-${user}`, status: 'succeeded' }] },
    };
    for (const [name, payload] of Object.entries(documents))
      await client.query(
        'INSERT INTO workspace_documents(user_id,name,payload) VALUES($1,$2,$3::jsonb)',
        [user, name, JSON.stringify(payload)],
      );
    await client.query(
      `INSERT INTO subscriptions(user_id,plan,status,customer_id,subscription_id,current_period_end,
         checkout_attempt_id,checkout_started_at,checkout_session_id,checkout_request)
       VALUES($1,$2,'active',$3,$4,now()+interval '30 days',$5,now(),$6,$7::jsonb)`,
      [
        user,
        index ? 'pro' : 'free',
        `cus_synthetic_${user}`,
        `sub_synthetic_${user}`,
        randomUUID(),
        `cs_synthetic_${user}`,
        JSON.stringify({ fixture: true, client_reference_id: user }),
      ],
    );
    await client.query(
      "INSERT INTO usage_events(user_id,id,kind,period,quantity) VALUES($1,$2,'analysis','2026-10',1)",
      [user, `usage-${user}`],
    );
    for (const status of ['succeeded', 'queued']) {
      const id = `${status}-${user}`;
      await client.query(
        'INSERT INTO jobs(user_id,id,kind,status,payload,result,attempts) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',
        [
          user,
          id,
          'product-analysis',
          status,
          JSON.stringify({ endpoint: '/api/analyze-product', input: { requestId: id, product } }),
          status === 'succeeded' ? JSON.stringify({ synthetic: true, saved: true }) : null,
          status === 'succeeded' ? 1 : 0,
        ],
      );
      if (status === 'queued')
        await client.query('INSERT INTO job_dispatch(user_id,id) VALUES($1,$2)', [user, id]);
    }
    await client.query(
      'INSERT INTO capture_events(user_id,id,payload_hash,product_id) VALUES($1,$2,$3,$4)',
      [user, `capture-${user}`, hash(JSON.stringify(product)), product.id],
    );
    await client.query('INSERT INTO audit_events(id,user_id,action) VALUES($1,$2,$3)', [
      randomUUID(),
      user,
      'synthetic.logical-recovery',
    ]);
  }
  await client.query('INSERT INTO webhook_events(id) VALUES($1)', [
    `evt_synthetic_${randomUUID()}`,
  ]);
  await client.query('INSERT INTO api_rate_limits(key,window_start,count) VALUES($1,now(),2)', [
    `synthetic:${randomUUID()}`,
  ]);
}

async function verifyRLS(client, users) {
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
      const expected = table === 'workspace_documents' ? 5 : table === 'jobs' ? 2 : 1;
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
    fixture: 'Synthetic SQL records only; no real user data or AI/payment provider call',
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
    const users = [randomUUID(), randomUUID()];
    await seed(source, users);
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
    report.rls = await verifyRLS(restoredApp, users);
    // Re-run checksums after the rejected-write probe, proving it left restored data unchanged.
    assert.deepEqual(await snapshot(target), before);
    report.tables = restored;
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
