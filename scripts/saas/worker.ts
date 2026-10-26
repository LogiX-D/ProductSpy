import { runPendingAIJobsOnce } from '../../apps/web/src/lib/saas/job-worker';
import { closeDatabase } from '../../apps/web/src/lib/saas/database';
let stop = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stop = true;
  });
async function main() {
  if (process.env.PRODUCTSPY_DB_DRIVER === 'pglite')
    throw new Error(
      'Independent worker requires network PostgreSQL. Use inline runner for PGlite development.',
    );
  process.env.PRODUCTSPY_MODE = 'saas';
  try {
    do {
      const processed = await runPendingAIJobsOnce();
      if (process.argv.includes('--once')) {
        console.log(`Processed ${processed} queued tasks.`);
        break;
      }
      if (!stop) await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!stop);
  } finally {
    await closeDatabase();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Worker failed');
  process.exitCode = 1;
});
