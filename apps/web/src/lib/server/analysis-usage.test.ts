import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ANALYSIS_OPTIONS } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisUsageLedger, requestFingerprint } from './analysis-usage';

describe('AnalysisUsageLedger', () => {
  let directory: string;
  let ledger: AnalysisUsageLedger;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-usage-'));
    ledger = new AnalysisUsageLedger(directory);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  function reservation(mode: 'mock' | 'real' = 'real') {
    return {
      requestId: randomUUID(),
      productId: 'amazon:B012345678',
      fingerprint: requestFingerprint({ product: 'B012345678', requirements: 'private user text' }),
      mode,
      options: { ...DEFAULT_ANALYSIS_OPTIONS, customInstructions: 'private user text' },
    };
  }

  it('persists a reservation before calling AI and never logs private input text', async () => {
    const input = reservation();
    await ledger.begin(input);
    const data = await readFile(ledger.filePath, 'utf8');
    expect(data).toContain('started');
    expect(data).not.toContain('private user text');
    expect((await new AnalysisUsageLedger(directory).get(input.requestId))?.fingerprint).toBe(
      input.fingerprint,
    );
    await ledger.finish(input.requestId, {
      usage: { inputTokens: 100, outputTokens: 200, costUsd: 0.005, costEstimated: true },
    });
    const report = await ledger.report();
    expect(report.totals).toMatchObject({
      requests: 1,
      realRequests: 1,
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.005,
      unknownCostRequests: 0,
    });
    expect(report.records[0]?.status).toBe('succeeded');
    expect(report.records[0]).not.toHaveProperty('fingerprint');
  });

  it('blocks duplicate identifiers and applies concurrency and daily bounds', async () => {
    vi.stubEnv('AI_DAILY_REQUEST_LIMIT', '2');
    const first = reservation();
    const second = reservation();
    await ledger.begin(first);
    await expect(ledger.begin(first)).rejects.toMatchObject({ status: 409 });
    await expect(
      ledger.begin({ ...first, fingerprint: requestFingerprint('changed') }),
    ).rejects.toMatchObject({ status: 409 });
    await ledger.begin(second);
    await expect(ledger.begin(reservation())).rejects.toMatchObject({ status: 429 });
    await ledger.finish(first.requestId, { errorCode: 502 });
    await ledger.finish(second.requestId, { errorCode: 409 });
    await expect(ledger.begin(reservation())).rejects.toMatchObject({ status: 429 });
    const report = await ledger.report();
    expect(report.totals.unknownCostRequests).toBe(2);
    expect(report.totals.unknownTokenRequests).toBe(2);
    expect(report.limits.dailyRealRequests).toBe(2);
    expect(report.records.map((record) => record.status)).toEqual(['conflict', 'failed']);
    const mock = reservation('mock');
    await ledger.begin(mock);
    await ledger.finish(mock.requestId, {
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costEstimated: false },
    });
    expect((await ledger.report()).totals.requests).toBe(3);
  });

  it('persists a safe Retry-After cooldown and never treats unknown tokens as known zero', async () => {
    const first = reservation();
    await ledger.begin(first);
    await ledger.finish(first.requestId, { errorCode: 429, retryAfterSeconds: 120 });
    await expect(new AnalysisUsageLedger(directory).begin(reservation())).rejects.toMatchObject({
      status: 429,
    });
    const report = await ledger.report();
    expect(Date.parse(report.limits.cooldownUntil ?? '')).toBeGreaterThan(Date.now());
    expect(report.totals.unknownTokenRequests).toBe(1);
    expect(report.records[0]?.usage).toBeUndefined();
  });

  it('fails closed when the ledger is corrupt instead of resetting cost history', async () => {
    await writeFile(ledger.filePath, '{broken');
    await expect(ledger.begin(reservation())).rejects.toMatchObject({ status: 500 });
    expect(await readFile(ledger.filePath, 'utf8')).toBe('{broken');
  });

  it('does not write an unreadable ledger when environment model configuration is invalid', async () => {
    await expect(ledger.begin({ ...reservation(), model: 'x'.repeat(201) })).rejects.toMatchObject({
      status: 503,
    });
    expect((await ledger.report()).records).toEqual([]);
  });
});
