import { migrateDatabase } from '../../apps/web/src/lib/saas/database';
async function main() {
  await migrateDatabase();
  console.log('ProductSpy database schema is ready.');
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
});
