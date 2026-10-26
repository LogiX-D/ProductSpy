import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ANALYSIS_OPTIONS } from '@productspy/shared';
import { closeDatabase, dbTransaction, ensureDatabase, query } from './database';
import { currentUserId, withTenant } from './context';
import {
  readWorkspaceDocument,
  writeWorkspaceDocument,
  commitWorkspaceDocuments,
} from './workspace-storage';
import {
  getProductRepository,
  dataDirectory,
  LocalJsonProductRepository,
} from '../server/product-repository';
import { getComparisonRepository } from '../server/comparison-repository';
import { getTemplateRepository } from '../server/template-repository';
import { getContentRepository } from '../server/content-repository';
import { WorkspaceBackupService } from '../server/business-backup';
import { getAnalysisUsageLedger } from '../server/analysis-usage';

const draft = {
  source: 'amazon' as const,
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Synthetic SaaS fixture',
  images: [],
  videos: [],
  bulletPoints: [],
};
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'productspy-postgres-'));
  vi.stubEnv('PRODUCTSPY_MODE', 'saas');
  vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pglite');
  vi.stubEnv('PRODUCTSPY_PGLITE_DIR', join(directory, 'absent-parent', 'nested', 'database'));
  await ensureDatabase();
  for (const id of ['alice', 'bob', 'quota', 'restore', 'capacity'])
    await query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      id,
      `${id}@example.invalid`,
      'synthetic-hash',
    ]);
}, 30000);
afterAll(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('SaaS PostgreSQL persistence and tenant boundaries', () => {
  it('requires a user scope and never silently selects a shared filesystem repository', () => {
    expect(() => currentUserId()).toThrow();
    expect(() => getProductRepository()).toThrow();
  });
  it('isolates identical ASINs and concurrent captures across accounts without writing legacy JSON', async () => {
    await Promise.all([
      withTenant('alice', async () => {
        await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            getProductRepository().upsert({ ...draft, title: `Alice ${index}` }),
          ),
        );
        expect(await getProductRepository().list()).toHaveLength(1);
        await expect(access(dataDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
      }),
      withTenant('bob', async () => {
        expect(await getProductRepository().list()).toEqual([]);
        await getProductRepository().upsert({ ...draft, title: 'Bob private product' });
      }),
    ]);
    await withTenant('alice', async () =>
      expect((await getProductRepository().list())[0].title).toBe('Alice 7'),
    );
    await withTenant('bob', async () =>
      expect((await getProductRepository().list())[0].title).toBe('Bob private product'),
    );
  });
  it('rejects a captured repository reused from a different tenant and nested scope switching', async () => {
    let repository!: LocalJsonProductRepository;
    await withTenant('alice', async () => {
      repository = getProductRepository();
    });
    await withTenant('bob', async () => {
      await expect(repository.list()).rejects.toThrow('another tenant');
      await expect(withTenant('alice', async () => undefined)).rejects.toMatchObject({
        status: 403,
      });
    });
  });
  it('rolls back document mutations and validates every restore document before writing', async () => {
    await withTenant('alice', async () => {
      const root = dataDirectory();
      const before = await readWorkspaceDocument(root, 'products.json');
      await expect(
        dbTransaction(async () => {
          await writeWorkspaceDocument(root, 'products.json', '[]');
          throw new Error('synthetic failure');
        }),
      ).rejects.toThrow('synthetic failure');
      expect(await readWorkspaceDocument(root, 'products.json')).toBe(before);
      await expect(
        commitWorkspaceDocuments(root, { 'products.json': '[]', 'content-plans.json': 'invalid' }),
      ).rejects.toThrow();
      expect(await readWorkspaceDocument(root, 'products.json')).toBe(before);
    });
  });
  it('reuses comparison/template/content schemas and exports only the authenticated workspace', async () => {
    const backup = await withTenant('alice', async () => {
      const first = (await getProductRepository().list())[0];
      const second = await getProductRepository().upsert({
        ...draft,
        sourceId: 'B012345679',
        url: 'https://www.amazon.com/dp/B012345679',
      });
      await getComparisonRepository().create('Alice comparison', [first, second]);
      const template = (await getTemplateRepository().list())[0];
      await getContentRepository().create('Alice content', first, template);
      return new WorkspaceBackupService().export();
    });
    expect(backup.comparisons).toHaveLength(1);
    expect(backup.contentPlans).toHaveLength(1);
    await withTenant('bob', async () => {
      const own = await new WorkspaceBackupService().export();
      expect(own.comparisons).toEqual([]);
      expect(own.contentPlans).toEqual([]);
      expect(own.library.products[0].title).toBe('Bob private product');
    });
    await withTenant('restore', async () => {
      const service = new WorkspaceBackupService();
      const preview = await service.restore(backup, {});
      expect(
        (
          await service.restore(backup, {
            commit: true,
            confirmed: true,
            policy: 'skip',
            expectedRevision: preview.preview.revision,
          })
        ).committed,
      ).toBe(true);
      expect((await service.export()).contentPlans).toHaveLength(1);
    });
  });
  it('atomically reserves mock-mode quota and jobs, rejects over-quota requests without partial records', async () => {
    await withTenant('quota', async () => {
      const ledger = getAnalysisUsageLedger();
      for (let index = 0; index < 10; index++) {
        const requestId = randomUUID();
        await ledger.begin({
          requestId,
          productId: 'amazon:B012345678',
          fingerprint: 'a'.repeat(64),
          mode: 'mock',
          options: DEFAULT_ANALYSIS_OPTIONS,
        });
        await ledger.finish(requestId, {});
      }
      const requestId = randomUUID();
      await expect(
        ledger.begin({
          requestId,
          productId: 'amazon:B012345678',
          fingerprint: 'b'.repeat(64),
          mode: 'mock',
          options: DEFAULT_ANALYSIS_OPTIONS,
        }),
      ).rejects.toMatchObject({ status: 429 });
      expect(await ledger.get(requestId)).toBeUndefined();
      expect(
        (
          await query<{ count: number }>(
            'SELECT count(*)::int AS count FROM usage_events WHERE user_id=$1',
            ['quota'],
          )
        ).rows[0].count,
      ).toBe(10);
      expect(
        (
          await query<{ count: number }>(
            'SELECT count(*)::int AS count FROM jobs WHERE user_id=$1 AND status=$2',
            ['quota', 'succeeded'],
          )
        ).rows[0].count,
      ).toBe(10);
    });
  });
  it('enforces database row policies for a role without owner or superuser bypass', async () => {
    await query('CREATE ROLE productspy_test_restricted NOLOGIN');
    await query('GRANT USAGE ON SCHEMA public TO productspy_test_restricted');
    await query(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_documents TO productspy_test_restricted',
    );
    await withTenant('alice', async () => {
      await dbTransaction(async () => {
        await query('SET LOCAL ROLE productspy_test_restricted');
        const rows = await query<{ user_id: string }>('SELECT user_id FROM workspace_documents');
        expect(rows.rows.length).toBeGreaterThan(0);
        expect(rows.rows.every((row) => row.user_id === 'alice')).toBe(true);
      });
      await expect(
        dbTransaction(async () => {
          await query('SET LOCAL ROLE productspy_test_restricted');
          await query(
            'INSERT INTO workspace_documents(user_id,name,payload) VALUES($1,$2,$3::jsonb)',
            ['bob', 'templates.json', '{}'],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });
  });
  it('enforces product capacity at persistence, including import and downgrade cleanup', async () => {
    await withTenant('capacity', async () => {
      const root = dataDirectory();
      const stamp = new Date().toISOString();
      const products = Array.from({ length: 51 }, (_, index) => {
        const asin = `B${String(index).padStart(9, '0')}`;
        return {
          ...draft,
          id: `amazon:${asin}`,
          sourceId: asin,
          url: `https://www.amazon.com/dp/${asin}`,
          createdAt: stamp,
          updatedAt: stamp,
        };
      });
      const document = (items: unknown[]) =>
        JSON.stringify({ schemaVersion: 2, products: items, groups: [], tags: [] });
      await expect(
        writeWorkspaceDocument(root, 'products.json', document(products)),
      ).rejects.toMatchObject({ status: 403 });
      await expect(readWorkspaceDocument(root, 'products.json')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await query(
        "INSERT INTO subscriptions(user_id,plan,status) VALUES('capacity','pro','active')",
      );
      await writeWorkspaceDocument(root, 'products.json', document(products));
      await query("UPDATE subscriptions SET plan='free' WHERE user_id='capacity'");
      await writeWorkspaceDocument(root, 'products.json', document(products));
      await writeWorkspaceDocument(root, 'products.json', document(products.slice(0, 50)));
      await expect(
        writeWorkspaceDocument(root, 'products.json', document(products)),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
  it('persists the database through a process-connection restart', async () => {
    await closeDatabase();
    await ensureDatabase();
    await withTenant('bob', async () =>
      expect((await getProductRepository().list())[0].title).toBe('Bob private product'),
    );
  }, 30000);
});
