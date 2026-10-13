import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Keep worker artifacts outside the watched source/build tree. The tests and
// their timeouts are unchanged. Publish the quality evidence after workers exit.
const workspace = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'productspy-unit-report-'));
const qualityPath = join(temporary, 'quality.json');
const child = spawn(
  process.execPath,
  [join(workspace, 'node_modules/vitest/vitest.mjs'), 'run', ...process.argv.slice(2)],
  {
    cwd: workspace,
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, PRODUCTSPY_QUALITY_REPORT_PATH: qualityPath },
  },
);
const code = await new Promise((complete, reject) => {
  child.on('error', reject);
  child.on('close', complete);
});
try {
  const source = await readFile(qualityPath, 'utf8');
  const report = JSON.parse(source);
  if (report.provider !== 'local Mock' || report.externalRequests !== 0 || report.cases !== 72)
    throw new Error('Quality evidence contract is invalid');
  const output = resolve(workspace, '.test-data/phase12-quality');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), source);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // Filtered unit runs that do not select the quality suite have no report.
}
process.exitCode = typeof code === 'number' ? code : 1;
