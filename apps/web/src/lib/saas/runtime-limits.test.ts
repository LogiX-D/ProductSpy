import { afterEach, describe, expect, it, vi } from 'vitest';
import { databasePoolMax, workerConcurrency } from './runtime-limits';
import { closeDatabase, ensureDatabase } from './database';

const postgres = vi.hoisted(() => ({
  constructor: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) {
      postgres.constructor(options);
    }
    connect = postgres.connect;
    end = postgres.end;
  },
}));

afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Server process resource settings', () => {
  it('preserves existing defaults when unset', () => {
    vi.stubEnv('PRODUCTSPY_DB_POOL_MAX', undefined);
    vi.stubEnv('PRODUCTSPY_WORKER_CONCURRENCY', undefined);
    expect(databasePoolMax()).toBe(12);
    expect(workerConcurrency()).toBe(2);
  });
  it.each(['', ' ', '0', '-1', '1.5', '1e1', '01', 'NaN', '999999999999999999'])(
    'refuses malformed or unbounded settings before work: %j',
    (value) => {
      vi.stubEnv('PRODUCTSPY_DB_POOL_MAX', value);
      vi.stubEnv('PRODUCTSPY_WORKER_CONCURRENCY', value);
      expect(databasePoolMax).toThrow('PRODUCTSPY_DB_POOL_MAX');
      expect(workerConcurrency).toThrow('PRODUCTSPY_WORKER_CONCURRENCY');
    },
  );
  it('accepts supported boundaries and refuses values above each maximum', () => {
    vi.stubEnv('PRODUCTSPY_DB_POOL_MAX', '1');
    vi.stubEnv('PRODUCTSPY_WORKER_CONCURRENCY', '1');
    expect(databasePoolMax()).toBe(1);
    expect(workerConcurrency()).toBe(1);
    vi.stubEnv('PRODUCTSPY_DB_POOL_MAX', '20');
    vi.stubEnv('PRODUCTSPY_WORKER_CONCURRENCY', '10');
    expect(databasePoolMax()).toBe(20);
    expect(workerConcurrency()).toBe(10);
    vi.stubEnv('PRODUCTSPY_DB_POOL_MAX', '21');
    vi.stubEnv('PRODUCTSPY_WORKER_CONCURRENCY', '11');
    expect(databasePoolMax).toThrow();
    expect(workerConcurrency).toThrow();
  });
  it('applies the small-host pool size to the actual PostgreSQL constructor', async () => {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', undefined);
    vi.stubEnv('DATABASE_URL', 'postgresql://synthetic.invalid/resource-test');
    vi.stubEnv('PRODUCTSPY_AUTO_MIGRATE', '0');
    vi.stubEnv('PRODUCTSPY_DB_POOL_MAX', '3');
    postgres.connect.mockResolvedValue({ query: postgres.query, release: postgres.release });
    postgres.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await ensureDatabase();
    expect(postgres.constructor).toHaveBeenCalledWith(
      expect.objectContaining({ max: 3, connectionTimeoutMillis: 10000 }),
    );
    expect(postgres.connect).toHaveBeenCalledOnce();
  });
  it('refuses invalid pool configuration without creating a connection pool', async () => {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', undefined);
    vi.stubEnv('DATABASE_URL', 'postgresql://synthetic.invalid/resource-test');
    vi.stubEnv('PRODUCTSPY_DB_POOL_MAX', '0');
    await expect(ensureDatabase()).rejects.toThrow('PRODUCTSPY_DB_POOL_MAX');
    expect(postgres.constructor).not.toHaveBeenCalled();
    expect(postgres.connect).not.toHaveBeenCalled();
  });
});
