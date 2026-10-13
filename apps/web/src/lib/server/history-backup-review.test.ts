import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ANALYSIS_OPTIONS } from '@productspy/shared';
import { WorkspaceBackupService } from './business-backup';
import { AnalysisUsageLedger } from './analysis-usage';
import { withBusinessOperation } from './business-lock';

describe('independent backup safety review', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-history-backup-review-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Review tests must not call any AI endpoint');
      }),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });
  it('retains exact existing real request reservations and the daily limit through older backup restore', async () => {
    // A local reservation is not a provider call. No Key is configured and fetch must remain unused.
    vi.stubEnv('AI_DAILY_REQUEST_LIMIT', '1');
    const ledger = new AnalysisUsageLedger(directory);
    const requestId = randomUUID();
    await ledger.begin({
      requestId,
      productId: 'synthetic-product',
      fingerprint: 'a'.repeat(64),
      mode: 'real',
      options: DEFAULT_ANALYSIS_OPTIONS,
    });
    await ledger.finish(requestId, { errorCode: 503 });
    const originalRecord = await ledger.get(requestId);
    const backup = await new WorkspaceBackupService(directory).export();
    backup.usage[0]!.createdAt = '2020-01-01T00:00:00.000Z';
    backup.usage[0]!.status = 'succeeded';
    backup.usage[0]!.errorCode = undefined;
    const service = new WorkspaceBackupService(directory);
    const preview = await service.restore(backup, {});
    await service.restore(backup, {
      commit: true,
      confirmed: true,
      policy: 'preserve',
      expectedRevision: preview.preview.revision,
    });
    expect(await ledger.get(requestId)).toEqual(originalRecord);
    expect((await ledger.report()).limits.dailyRealRequests).toBe(1);
    await expect(
      ledger.begin({
        requestId: randomUUID(),
        productId: 'different-product',
        fingerprint: 'b'.repeat(64),
        mode: 'real',
        options: DEFAULT_ANALYSIS_OPTIONS,
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('concurrent ledger reservations and a restore never lose a request or silently replay its fingerprint', async () => {
    const service = new WorkspaceBackupService(directory),
      ledger = new AnalysisUsageLedger(directory);
    const requestId = randomUUID();
    await ledger.begin({
      requestId,
      productId: 'synthetic-one',
      fingerprint: 'a'.repeat(64),
      mode: 'mock',
      options: DEFAULT_ANALYSIS_OPTIONS,
    });
    await ledger.finish(requestId, {});
    const older = await service.export();
    const preview = await service.restore(older, {});
    const secondId = randomUUID();
    const outcomes = await Promise.allSettled([
      service.restore(older, {
        commit: true,
        confirmed: true,
        policy: 'skip',
        expectedRevision: preview.preview.revision,
      }),
      ledger.begin({
        requestId: secondId,
        productId: 'synthetic-two',
        fingerprint: 'b'.repeat(64),
        mode: 'mock',
        options: DEFAULT_ANALYSIS_OPTIONS,
      }),
    ]);
    expect(outcomes[1]?.status).toBe('fulfilled');
    if (outcomes[0]?.status === 'rejected')
      expect(outcomes[0].reason).toMatchObject({ status: 409 });
    expect((await ledger.report()).records.map((record) => record.requestId).sort()).toEqual(
      [requestId, secondId].sort(),
    );
    await expect(
      ledger.begin({
        requestId: secondId,
        productId: 'synthetic-two',
        fingerprint: 'b'.repeat(64),
        mode: 'mock',
        options: DEFAULT_ANALYSIS_OPTIONS,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses a restore-stage directory junction without reading or deleting its target', async () => {
    const target = join(directory, 'unrelated-user-files');
    await mkdir(target);
    const sentinel = join(target, 'journal.json');
    await writeFile(sentinel, 'ordinary user file, not a restore journal');
    await symlink(
      target,
      join(directory, '.workspace-restore'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(withBusinessOperation(directory, async () => undefined)).rejects.toMatchObject({
      status: 500,
    });
    expect(await readFile(sentinel, 'utf8')).toBe('ordinary user file, not a restore journal');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps local private settings and pairing file byte-identical during full business restore', async () => {
    const excluded = ['settings.json', 'bridge-auth.json', '.env'];
    for (const file of excluded)
      await writeFile(join(directory, file), `synthetic private sentinel ${file}`);
    const service = new WorkspaceBackupService(directory);
    const backup = await service.export();
    expect(JSON.stringify(backup)).not.toContain('synthetic private sentinel');
    const preview = await service.restore(backup, {});
    await service.restore(backup, {
      commit: true,
      confirmed: true,
      policy: 'skip',
      expectedRevision: preview.preview.revision,
    });
    for (const file of excluded)
      expect(await readFile(join(directory, file), 'utf8')).toBe(
        `synthetic private sentinel ${file}`,
      );
    expect(fetch).not.toHaveBeenCalled();
  });
});
