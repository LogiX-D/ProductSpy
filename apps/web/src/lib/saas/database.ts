import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import { migrationSQL } from './migrations';
import { databasePoolMax } from './runtime-limits';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}
interface Connection {
  client?: PoolClient;
  transaction?: boolean;
  embeddedLock?: boolean;
}
interface DatabaseState {
  key: string;
  pool?: Pool;
  embedded?: PGlite;
  ready?: Promise<void>;
  tail: Promise<unknown>;
}
const globals = globalThis as typeof globalThis & {
  __productspyDatabase?: DatabaseState;
  __productspyConnection?: AsyncLocalStorage<Connection>;
};
const connection = (globals.__productspyConnection ??= new AsyncLocalStorage<Connection>());

function configuredKey(): string {
  if (process.env.PRODUCTSPY_DB_DRIVER === 'pglite')
    return `pglite:${process.env.PRODUCTSPY_PGLITE_DIR || 'memory://'}`;
  if (process.env.DATABASE_URL) return `pg:${process.env.DATABASE_URL}`;
  throw new Error('SaaS requires DATABASE_URL, or PRODUCTSPY_DB_DRIVER=pglite for development.');
}
function state(): DatabaseState {
  const key = configuredKey();
  const existing = globals.__productspyDatabase;
  if (existing && existing.key !== key)
    throw new Error('Close the database before changing database configuration.');
  return (globals.__productspyDatabase ??= { key, tail: Promise.resolve() });
}
/** Dedicated CLI path. Its administrative connection never enters the application pool. */
export async function migrateDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('db:migrate requires a PostgreSQL DATABASE_URL.');
  const { Pool: PostgresPool } = await import('pg');
  const pool = new PostgresPool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(761993482)');
      await client.query(migrationSQL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
export async function ensureDatabase(): Promise<void> {
  const database = state();
  database.ready ??= (async () => {
    const production =
      process.env.PRODUCTSPY_ENV === 'production' ||
      (process.env.NODE_ENV === 'production' &&
        !['test', 'development'].includes(process.env.PRODUCTSPY_ENV ?? ''));
    if (database.key.startsWith('pglite:')) {
      if (
        production ||
        (process.env.NODE_ENV === 'production' && process.env.PRODUCTSPY_ALLOW_PGLITE !== '1')
      )
        throw new Error(
          'Production requires PostgreSQL; PGlite is a single-process development database.',
        );
      const { PGlite: EmbeddedPostgres } = await import('@electric-sql/pglite');
      if (process.env.PRODUCTSPY_PGLITE_DIR && process.env.PRODUCTSPY_PGLITE_DIR !== 'memory://')
        await mkdir(resolve(/* turbopackIgnore: true */ process.env.PRODUCTSPY_PGLITE_DIR), {
          recursive: true,
        });
      database.embedded = new EmbeddedPostgres(process.env.PRODUCTSPY_PGLITE_DIR || undefined);
      await database.embedded.waitReady;
      await database.embedded.exec(migrationSQL);
    } else {
      const { Pool: PostgresPool } = await import('pg');
      database.pool = new PostgresPool({
        connectionString: process.env.DATABASE_URL,
        max: databasePoolMax(),
        connectionTimeoutMillis: 10000,
      });
      const client = await database.pool.connect();
      let locked = false;
      try {
        if (production) {
          // Inspect both identities: a privileged login can start with SET ROLE to
          // conceal its session_user, then recover privileges with RESET ROLE.
          const role = await client.query<{ unsafe: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_roles
             WHERE (rolsuper OR rolbypassrls) AND
             (pg_has_role(current_user,oid,'MEMBER') OR pg_has_role(session_user,oid,'MEMBER'))) AS unsafe`,
          );
          if (role.rows[0]?.unsafe !== false)
            throw new Error(
              'Production application requires a NOSUPERUSER/NOBYPASSRLS role without privileged memberships; use the separate db:migrate command for schema administration.',
            );
        }
        await client.query('SELECT pg_advisory_lock(761993482)');
        locked = true;
        // Deployments can apply migrationSQL separately and disable automatic DDL for the app role.
        const autoMigrate =
          process.env.PRODUCTSPY_AUTO_MIGRATE === '1' ||
          process.env.DB_MIGRATE_ON_START === '1' ||
          (process.env.NODE_ENV !== 'production' && process.env.PRODUCTSPY_AUTO_MIGRATE !== '0');
        if (autoMigrate) await client.query(migrationSQL);
      } finally {
        let discard = false;
        if (locked)
          await client.query('SELECT pg_advisory_unlock(761993482)').catch(() => {
            discard = true;
          });
        client.release(discard);
      }
    }
  })();
  return database.ready;
}
async function embeddedExclusive<T>(operation: () => Promise<T>): Promise<T> {
  if (connection.getStore()?.embeddedLock) return operation();
  const database = state();
  const prior = database.tail;
  let release!: () => void;
  database.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prior.catch(() => undefined);
  try {
    return await connection.run({ ...connection.getStore(), embeddedLock: true }, operation);
  } finally {
    release();
  }
}
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  await ensureDatabase();
  const database = state();
  if (database.embedded)
    return embeddedExclusive(async () => {
      const result = await database.embedded!.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    });
  const result = await (connection.getStore()?.client ?? database.pool!).query(sql, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}
export async function dbTransaction<T>(operation: () => Promise<T>): Promise<T> {
  await ensureDatabase();
  if (connection.getStore()?.transaction) return operation();
  const database = state();
  if (database.embedded)
    return embeddedExclusive(async () => {
      await query('BEGIN');
      try {
        const result = await connection.run(
          { ...connection.getStore(), transaction: true },
          operation,
        );
        await query('COMMIT');
        return result;
      } catch (error) {
        await query('ROLLBACK');
        throw error;
      }
    });
  const inherited = connection.getStore()?.client;
  const client = inherited ?? (await database.pool!.connect());
  try {
    await client.query('BEGIN');
    const result = await connection.run({ client, transaction: true }, operation);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (!inherited) client.release();
  }
}
/** Keep tenant mutations serialized across PostgreSQL application instances without a long transaction. */
export async function withDatabaseTenant<T>(
  userId: string,
  operation: () => Promise<T>,
  serialize = true,
): Promise<T> {
  await ensureDatabase();
  const database = state();
  if (database.embedded)
    return embeddedExclusive(async () => {
      await query("SELECT set_config('app.user_id',$1,false)", [userId]);
      try {
        return await operation();
      } finally {
        await query("SELECT set_config('app.user_id','',false)");
      }
    });
  const client = await database.pool!.connect();
  try {
    if (serialize)
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        `productspy:${userId}`,
      ]);
    await client.query("SELECT set_config('app.user_id',$1,false)", [userId]);
    return await connection.run({ client }, operation);
  } finally {
    let discard = false;
    await client.query("SELECT set_config('app.user_id','',false)").catch(() => {
      discard = true;
    });
    if (serialize)
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`productspy:${userId}`])
        .catch(() => {
          discard = true;
        });
    // Never return a connection with an unknown tenant scope or a held session lock to the pool.
    client.release(discard);
  }
}
export async function closeDatabase(): Promise<void> {
  const database = globals.__productspyDatabase;
  if (!database) return;
  await database.ready?.catch(() => undefined);
  await database.tail.catch(() => undefined);
  await database.pool?.end();
  await database.embedded?.close();
  globals.__productspyDatabase = undefined;
}
