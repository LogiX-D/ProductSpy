import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { passwordHash } from '../../apps/web/src/lib/saas/accounts';
import { migrationSQL } from '../../apps/web/src/lib/saas/migrations';

// Synthetic fixtures for the isolated Playwright database only. This command is
// not used by application startup, deployment or production administration.
async function main() {
  const requireFromWeb = createRequire(resolve('apps/web/package.json'));
  const { PGlite } = requireFromWeb('@electric-sql/pglite');
  const id = '00000000-0000-4000-8000-000000000001';
  const root = resolve('.test-data/saas');
  const databasePath = resolve(process.env.PRODUCTSPY_PGLITE_DIR ?? '');
  const childPath = relative(root, databasePath);
  if (
    process.env.PRODUCTSPY_ENV !== 'test' ||
    process.env.PRODUCTSPY_MODE !== 'saas' ||
    process.env.PRODUCTSPY_DB_DRIVER !== 'pglite' ||
    process.env.PRODUCTSPY_AI_ADMIN_IDS !== id ||
    !childPath.startsWith('db-') ||
    childPath.startsWith('..') ||
    isAbsolute(childPath)
  )
    throw new Error('Browser fixtures require their own explicitly configured test database');
  await mkdir(dirname(databasePath), { recursive: true });
  const database = new PGlite(databasePath);
  try {
    await database.waitReady;
    await database.exec(migrationSQL);
    await database.query('INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,$3,$4)', [
      id,
      'channel-admin@example.invalid',
      await passwordHash('Synthetic-browser-admin-2026'),
      'Synthetic channel administrator',
    ]);
    await database.query(
      "INSERT INTO subscriptions(user_id,plan,status) VALUES($1,'free','active')",
      [id],
    );
  } finally {
    await database.close();
  }
  const child = spawn(process.execPath, [resolve('scripts/start-web.mjs'), 'start'], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    throw error;
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
