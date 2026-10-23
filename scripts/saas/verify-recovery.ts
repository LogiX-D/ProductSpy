import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { query, closeDatabase } from '../../apps/web/src/lib/saas/database';
import { withTenant } from '../../apps/web/src/lib/saas/context';
import { getProductRepository } from '../../apps/web/src/lib/server/product-repository';
const file = resolve('.test-data/saas/postgres-recovery/sentinel.json');
const action = process.argv[2];
process.env.PRODUCTSPY_MODE = 'saas';
process.env.PRODUCTSPY_DB_DRIVER = 'pg';
process.env.PRODUCTSPY_AUTO_MIGRATE = '0';
async function main() {
  try {
    if (action === 'write') {
      const id = randomUUID();
      await query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
        id,
        `${id}@recovery.example.invalid`,
        'synthetic-no-login',
      ]);
      const product = await withTenant(id, () =>
        getProductRepository().upsert({
          source: 'amazon',
          sourceId: 'B011111111',
          url: 'https://www.amazon.com/dp/B011111111',
          title: 'Synthetic PostgreSQL recovery sentinel',
          images: [],
          videos: [],
          bulletPoints: [],
        }),
      );
      const expected = createHash('sha256').update(JSON.stringify(product)).digest('hex');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ id, expected }));
      console.log('Created an isolated synthetic recovery sentinel.');
    } else {
      const sentinel = JSON.parse(await readFile(file, 'utf8')) as { id: string; expected: string };
      if (action === 'cleanup') await query('DELETE FROM users WHERE id=$1', [sentinel.id]);
      else {
        const products = await withTenant(sentinel.id, () => getProductRepository().list());
        if (
          products.length !== 1 ||
          createHash('sha256').update(JSON.stringify(products[0])).digest('hex') !==
            sentinel.expected
        )
          throw new Error('Restored data does not match the sentinel');
        const other = await withTenant(randomUUID(), () => getProductRepository().list());
        if (other.length) throw new Error('Restored database tenant isolation failed');
        console.log(
          JSON.stringify({
            status: 'PASS',
            sentinelSha256: sentinel.expected,
            rows: products.length,
            otherTenantRows: other.length,
          }),
        );
      }
    }
  } finally {
    await closeDatabase();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Recovery verification failed');
  process.exitCode = 1;
});
