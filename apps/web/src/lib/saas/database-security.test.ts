import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, ensureDatabase, migrateDatabase } from './database';
import { migrationSQL } from './migrations';

const postgres = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: class {
    connect = postgres.connect;
    end = postgres.end;
  },
}));

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PRODUCTSPY_ENV', 'production');
  vi.stubEnv('PRODUCTSPY_DB_DRIVER', undefined);
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic.invalid/security-test');
  vi.stubEnv('PRODUCTSPY_AUTO_MIGRATE', '0');
  vi.stubEnv('DB_MIGRATE_ON_START', undefined);
  postgres.connect.mockResolvedValue({ query: postgres.query, release: postgres.release });
  postgres.query.mockResolvedValue({ rows: [{ unsafe: false }], rowCount: 1 });
});

afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('Production database isolation guard', () => {
  it('checks role and assumable privileged memberships before serving application queries', async () => {
    await ensureDatabase();
    const sql = postgres.query.mock.calls[0][0] as string;
    expect(sql).toContain('pg_roles');
    expect(sql).toContain('rolsuper');
    expect(sql).toContain('rolbypassrls');
    expect(sql).toContain('pg_has_role');
    expect(postgres.release).toHaveBeenCalledOnce();
  });

  it('rejects a role that can bypass RLS even if automatic migration is explicitly enabled', async () => {
    vi.stubEnv('PRODUCTSPY_AUTO_MIGRATE', '1');
    vi.stubEnv('DB_MIGRATE_ON_START', '1');
    postgres.query.mockResolvedValue({ rows: [{ unsafe: true }], rowCount: 1 });
    await expect(ensureDatabase()).rejects.toThrow('NOSUPERUSER/NOBYPASSRLS');
    expect(postgres.query).toHaveBeenCalledOnce();
    expect(postgres.release).toHaveBeenCalledOnce();
    // A cached failed readiness result must not begin serving queries later.
    await expect(ensureDatabase()).rejects.toThrow('NOSUPERUSER/NOBYPASSRLS');
  });

  it('rejects a privileged login concealed by SET ROLE, using actual PostgreSQL role semantics', async () => {
    await ensureDatabase();
    const sql = postgres.query.mock.calls[0][0] as string;
    const { PGlite } = await import('@electric-sql/pglite');
    const roles = new PGlite();
    try {
      await roles.exec(`
        CREATE ROLE guarded_admin SUPERUSER;
        CREATE ROLE guarded_app NOSUPERUSER NOBYPASSRLS;
        SET SESSION AUTHORIZATION guarded_admin;
        SET ROLE guarded_app;
      `);
      expect((await roles.query('SELECT current_user, session_user')).rows[0]).toEqual({
        current_user: 'guarded_app',
        session_user: 'guarded_admin',
      });
      expect((await roles.query(sql)).rows[0]).toEqual({ unsafe: true });
      await roles.exec('RESET ROLE; SET SESSION AUTHORIZATION guarded_app;');
      expect((await roles.query(sql)).rows[0]).toEqual({ unsafe: false });
    } finally {
      await roles.close();
    }
  }, 30000);

  it('fails closed if role metadata cannot establish a safe application connection', async () => {
    postgres.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(ensureDatabase()).rejects.toThrow('NOSUPERUSER/NOBYPASSRLS');
    expect(postgres.release).toHaveBeenCalledOnce();
  });

  it.each(['production', undefined])(
    'does not permit PGlite in an actual production environment (%s)',
    async (environment) => {
      vi.stubEnv('PRODUCTSPY_ENV', environment);
      vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pglite');
      vi.stubEnv('PRODUCTSPY_ALLOW_PGLITE', '1');
      await expect(ensureDatabase()).rejects.toThrow('Production requires PostgreSQL');
      expect(postgres.connect).not.toHaveBeenCalled();
    },
  );

  it('enforces the production environment flag when NODE_ENV was not set by a worker launcher', async () => {
    vi.stubEnv('NODE_ENV', undefined);
    postgres.query.mockResolvedValue({ rows: [{ unsafe: true }], rowCount: 1 });
    await expect(ensureDatabase()).rejects.toThrow('NOSUPERUSER/NOBYPASSRLS');
  });

  it('uses a separate transactional migration connection that cannot authorize the application pool', async () => {
    postgres.query.mockResolvedValue({ rows: [{ unsafe: true }], rowCount: 1 });
    await migrateDatabase();
    expect(postgres.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(761993482)',
      migrationSQL,
      'COMMIT',
    ]);
    expect(postgres.release).toHaveBeenCalledOnce();
    expect(postgres.end).toHaveBeenCalledOnce();
    await expect(ensureDatabase()).rejects.toThrow('NOSUPERUSER/NOBYPASSRLS');
    expect(postgres.connect).toHaveBeenCalledTimes(2);
  });

  it('rolls back a failed schema migration and closes its administrative connection', async () => {
    const failure = new Error('synthetic DDL failure');
    postgres.query.mockImplementation(async (sql: string) => {
      if (sql === migrationSQL) throw failure;
      return { rows: [], rowCount: 0 };
    });
    await expect(migrateDatabase()).rejects.toBe(failure);
    expect(postgres.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(761993482)',
      migrationSQL,
      'ROLLBACK',
    ]);
    expect(postgres.release).toHaveBeenCalledOnce();
    expect(postgres.end).toHaveBeenCalledOnce();
  });

  it('requires an explicit migration connection before opening a pool', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    await expect(migrateDatabase()).rejects.toThrow('DATABASE_URL');
    expect(postgres.connect).not.toHaveBeenCalled();
  });
});
