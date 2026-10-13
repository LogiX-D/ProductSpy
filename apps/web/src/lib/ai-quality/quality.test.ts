import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { MockAIProvider } from '../ai/mock-provider';
import { evaluateGeneration, type QualityCheck } from './evaluate';
import { qualityOptions, qualitySamples } from './samples';

const rows: {
  category: string;
  title: string;
  options: (typeof qualityOptions)[number];
  checks: QualityCheck[];
}[] = [];
describe('repeatable AI quality guardrails: synthetic fixtures + local Mock only', () => {
  for (const sample of qualitySamples)
    for (const options of qualityOptions) {
      it(`${sample.category} / ${options.market} / ${options.language} / ${options.duration}s`, async () => {
        const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
          throw new Error('Quality evaluation must never call external AI or fetch media');
        });
        try {
          const result = await new MockAIProvider().generate(sample.product, options);
          const checks = evaluateGeneration(sample.product, options, result, sample.missing);
          rows.push({ category: sample.category, title: sample.title, options, checks });
          expect(checks.filter((check) => !check.passed)).toEqual([]);
          expect(network).not.toHaveBeenCalled();
        } finally {
          network.mockRestore();
        }
      });
    }
  it('detects a fabricated specification and a false review-analysis claim in adversarial output', async () => {
    const sample = qualitySamples[0];
    const options = qualityOptions[0];
    const result = await new MockAIProvider().generate(sample.product, options);
    const unsafe = {
      ...result,
      analysis: {
        ...result.analysis,
        summary: `${result.analysis.summary} 10W。用户评论表明效果优秀。`,
      },
    };
    const checks = evaluateGeneration(sample.product, options, unsafe, sample.missing);
    expect(checks.find((check) => check.name === '未虚构测试哨兵参数')?.passed).toBe(false);
    expect(checks.find((check) => check.name === '不冒充评论分析')?.passed).toBe(false);
  });
});
afterAll(() => {
  const reportPath = resolve(
    process.env.PRODUCTSPY_QUALITY_REPORT_PATH ?? '.test-data/phase12-quality/report.json',
  );
  const output = dirname(reportPath);
  // Report publication is small and test-only. Complete it before the worker
  // shutdown rather than leave report I/O competing in the async worker pool.
  mkdirSync(output, { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        evaluatedAt: new Date().toISOString(),
        provider: 'local Mock',
        syntheticSamples: qualitySamples.length,
        cases: rows.length,
        checks: rows.reduce((total, row) => total + row.checks.length, 0),
        passed:
          rows.length === 72 && rows.every((row) => row.checks.every((check) => check.passed)),
        externalRequests: 0,
        realModelQualityVerified: false,
        rows,
      },
      null,
      2,
    ),
  );
});
