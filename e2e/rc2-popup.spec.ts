import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const run = promisify(execFile);

test('production extension action popup has stable roots and internal long-content scrolling', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(120000);
  const output = testInfo.outputPath('actual-action-popup');
  await run(
    process.execPath,
    [
      resolve('scripts/rc2-popup-diagnostics.mjs'),
      '--extension',
      resolve('apps/extension/dist'),
      '--output',
      output,
      '--assert-stable',
    ],
    { cwd: resolve('.'), timeout: 100000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  const report = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8')) as {
    action: { outcome: string };
    assertions: { name: string; passed: boolean }[];
    measurements: {
      kind: string;
      extensionView: { popup: boolean; tab: boolean };
      window: { innerWidth: number; innerHeight: number };
    }[];
  };
  expect(report.action.outcome).toBe('actual-action-popup-target-observed');
  const actual = report.measurements.find((item) => item.kind === 'actual-action-popup');
  expect(actual?.extensionView).toEqual({ popup: true, tab: false });
  expect(actual?.window).toMatchObject({ innerWidth: 400, innerHeight: 420 });
  expect(report.assertions.length).toBeGreaterThan(20);
  expect(report.assertions.filter((item) => !item.passed)).toEqual([]);
  await testInfo.attach('Actual action Popup diagnostics (synthetic layout QA)', {
    path: resolve(output, 'report.json'),
    contentType: 'application/json',
  });
  await testInfo.attach('Actual action Popup with synthetic long content', {
    path: resolve(output, 'actual-action-popup-synthetic-long-content.png'),
    contentType: 'image/png',
  });
});
