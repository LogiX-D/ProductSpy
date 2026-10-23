import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { closeDatabase, query } from '../../apps/web/src/lib/saas/database';
import { withTenant } from '../../apps/web/src/lib/saas/context';
import { WorkspaceBackupService } from '../../apps/web/src/lib/server/business-backup';

// Explicit, additive import of an exported legacy business backup. Source is never modified.
const [file, userId, commitFlag] = process.argv.slice(2);
if (!file || !userId)
  throw new Error('Usage: pnpm db:import-legacy <backup.json> <existing-user-id> [--commit]');
process.env.PRODUCTSPY_MODE = 'saas';
async function main() {
  try {
    const source = await readFile(resolve(file), 'utf8');
    const users = await query('SELECT id FROM users WHERE id=$1', [userId]);
    if (!users.rows.length) throw new Error('Target account must already exist.');
    await withTenant(userId, async () => {
      const service = new WorkspaceBackupService();
      const preview = await service.restore(JSON.parse(source), {});
      console.log(
        JSON.stringify(
          { sourceSha256: createHash('sha256').update(source).digest('hex'), preview },
          null,
          2,
        ),
      );
      if (commitFlag === '--commit') {
        const result = await service.restore(JSON.parse(source), {
          commit: true,
          confirmed: true,
          policy: 'preserve',
          expectedRevision: preview.preview.revision,
        });
        console.log(
          JSON.stringify({
            committed: result.committed,
            imported: result.imported,
            skipped: result.skipped,
          }),
        );
      }
    });
  } finally {
    await closeDatabase();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Import failed');
  process.exitCode = 1;
});
