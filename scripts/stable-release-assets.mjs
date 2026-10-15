import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { artifactPath } from './packaging/files.mjs';

const version = '1.0.0';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const report = await json('docs/stable-release-validation.json');
assert(report.passed && report.version === version);
assert(report.manual.passed === 1 && report.manual.pending === 52);
assert.equal(report.issue.status, 'fixed + manually verified');
assert.equal(report.realAi.calls, 0);
assert(report.preservation.oldReleasesAndAssetsUnchanged);
const releaseBytes = await readFile(artifactPath('release-manifest.json'));
const release = JSON.parse(releaseBytes.toString('utf8'));
assert.deepEqual(release, report.delivery, 'Accepted archive manifest must not change');
assert.equal(release.version, version);
for (const row of [release.portable, release.extension]) {
  assert(!row.file.includes('/') && !row.file.includes('\\'));
  const bytes = await readFile(artifactPath(row.file));
  assert.equal(bytes.length, row.bytes);
  assert.equal(sha(bytes), row.sha256, `Accepted ZIP changed: ${row.file}`);
}

async function immutable(name, bytes) {
  assert(!name.includes('/') && !name.includes('\\'));
  const path = artifactPath(name);
  try {
    await writeFile(path, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.deepEqual(await readFile(path), bytes, `Refuse to replace existing ${name}`);
  }
}
const copies = [
  ['docs/stable-release-validation.md', `ProductSpy-${version}-validation.md`],
  ['docs/stable-release-validation.json', `ProductSpy-${version}-validation.json`],
  ['docs/release-candidate-guide.md', `ProductSpy-${version}-user-guide.md`],
];
for (const [source, name] of copies) {
  const bytes = await readFile(source);
  const text = bytes.toString('utf8');
  assert(!/sk-(?:proj-)?[A-Za-z0-9_-]{24,}/.test(text), `Suspected key in ${source}`);
  assert(!/gh[pousr]_[A-Za-z0-9]{30,}/.test(text), `Suspected GitHub token in ${source}`);
  assert(
    !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text),
    `Private key in ${source}`,
  );
  await immutable(name, bytes);
}
await immutable(`ProductSpy-${version}-release-manifest.json`, releaseBytes);
const names = [
  release.portable.file,
  release.extension.file,
  'release-manifest.json',
  ...copies.map(([, name]) => name),
];
const assets = [];
for (const name of names) {
  const bytes = await readFile(artifactPath(name));
  assets.push({ name, bytes: bytes.length, sha256: sha(bytes) });
}
const sums = assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n') + '\n';
await immutable(`ProductSpy-${version}-SHA256SUMS.txt`, sums);
// The generic checksum is the current release entry point; previous versioned sums and old Release assets are never rewritten.
await writeFile(artifactPath('SHA256SUMS.txt'), sums);
assets.push({ name: 'SHA256SUMS.txt', bytes: Buffer.byteLength(sums), sha256: sha(sums) });
await immutable(
  `ProductSpy-${version}-upload-manifest.json`,
  JSON.stringify({ version, assets }, null, 2) + '\n',
);
const upgradeChecks = report.upgrades.reduce((sum, row) => sum + row.checks, 0);
const notes = `ProductSpy v${version}（正式版交付草稿，未公开）\n\n基于 v1.0.0-rc.2 制作，没有新增业务功能。Chrome Manifest 数字版本 ${release.extension.extensionVersion} 高于 rc.2 的 1.0.0.2；原配对、权限、离线队列和本地资料兼容性保持不变。rc.1 与 rc.2 的 Release、附件和本地冻结包保持原样。\n\n维护者在 2026-10-16 明确确认：同一台曾出现小黑框的电脑、正式 Google Chrome、v1.0.0-rc.2 工具栏 Popup 正常显示、可查看和操作，问题已修复。PAIRING-SMALL-WINDOW 为 fixed + manually verified，仅人工清单 C07 记为 pass；其余 52 项继续 pending，没有推断未提供的 Chrome 完整版本、DPI、截图或其他场景结果。\n\n正式包工程检查：${report.unit.files} 个文件 / ${report.unit.passed} 项单元测试，${report.e2e.expected} 项 E2E，${report.portable.checks} 项 Windows 便携生命周期检查，${report.upgrades.length} 条实际旧包升级路径 / ${upgradeChecks} 项检查，以及冻结依赖、TypeScript、ESLint、Prettier、生产构建和 ZIP 安全校验。Fixture、Mock、Stub 和 CFT 自动化不替代正式 Chrome / Windows 原生人工验收。真实收费 AI 请求 0；真实模型质量仍待授权验收。\n\n完整解压 Windows ZIP 后双击 ProductSpy.cmd；Chrome 扩展 ZIP 解压后按指南加载。保持原 unpacked 扩展路径与 ID，未同步离线资料前不要卸载旧扩展。更新不覆盖独立用户资料目录；升级前建议完整业务备份。SHA256SUMS.txt 覆盖本次附件。报告链接中的 rc.2 运行截图是有来源的历史证据，不冒称新正式版截图。\n\n本 Release 只创建草稿，不公开，不提交 Chrome Web Store。\n`;
await immutable(`ProductSpy-${version}-release-notes.md`, notes);
console.log(
  JSON.stringify(
    {
      version,
      assets,
      screenshots:
        'No new screenshot archive; referenced rc.2 screenshots retain their original provenance.',
      public: false,
      storeSubmitted: false,
    },
    null,
    2,
  ),
);
