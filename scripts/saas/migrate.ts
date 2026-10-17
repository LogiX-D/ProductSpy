import { ensureDatabase, closeDatabase } from '../../apps/web/src/lib/saas/database';
async function main() {
  process.env.DB_MIGRATE_ON_START = '1';
  try {
    await ensureDatabase();
    console.log('ProductSpy database schema is ready.');
  } finally {
    await closeDatabase();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
});
