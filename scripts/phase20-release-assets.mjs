import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { artifactPath, zipDirectory } from './packaging/files.mjs';
const fromWeb = createRequire(resolve('apps/web/package.json'));
const JSZip = fromWeb('jszip');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const version = '1.0.0-rc.1';
const report = JSON.parse(await readFile('docs/phase20-results.json', 'utf8'));
assert(report.passed && report.version === version && report.screenshots.count >= 40);
for (const item of [report.release.portable, report.release.extension]) {
  const bytes = await readFile(artifactPath(item.file));
  assert.equal(hash(bytes), item.sha256, 'Do not upload a package rebuilt after acceptance');
}
const provenance = JSON.parse(await readFile('docs/screenshots/phase20/provenance.json', 'utf8'));
const expectedScreenshotFiles = [
  'provenance.json',
  ...provenance.screenshots.map((item) => item.file),
].sort();
assert.deepEqual(
  (await readdir('docs/screenshots/phase20')).sort(),
  expectedScreenshotFiles,
  'Unverified screenshots must not enter the delivery',
);
for (const item of provenance.screenshots)
  assert.equal(hash(await readFile(item.path)), item.sha256);
const screenshots = artifactPath(`ProductSpy-${version}-screenshots.zip`);
await unlink(screenshots).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});
await zipDirectory(resolve('docs/screenshots/phase20'), screenshots);
const screenshotZip = await JSZip.loadAsync(await readFile(screenshots), {
  checkCRC32: true,
  createFolders: false,
});
assert.deepEqual(Object.keys(screenshotZip.files).sort(), expectedScreenshotFiles);
for (const item of provenance.screenshots)
  assert.equal(hash(await screenshotZip.file(item.file).async('nodebuffer')), item.sha256);

const copies = [
  ['docs/phase20-validation.md', `ProductSpy-${version}-validation.md`],
  ['docs/phase20-results.json', `ProductSpy-${version}-validation.json`],
  ['docs/phase20-security.md', `ProductSpy-${version}-security.md`],
  ['docs/release-candidate-guide.md', `ProductSpy-${version}-user-guide.md`],
  ['docs/workflow-backup-guide.md', `ProductSpy-${version}-workflow-guide.md`],
  ['artifacts/release-manifest.json', `ProductSpy-${version}-release-manifest.json`],
];
for (const [source, name] of copies) await cp(source, artifactPath(name));
const names = [
  `ProductSpy-${version}-windows-x64.zip`,
  `ProductSpy-${version}-extension.zip`,
  `ProductSpy-${version}-screenshots.zip`,
  ...copies.map(([, name]) => name),
];
const assets = [];
for (const name of names) {
  const path = artifactPath(name);
  assets.push({
    name,
    bytes: (await stat(path)).size,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  });
}
const sums = 'SHA256SUMS.txt';
await writeFile(
  artifactPath(sums),
  assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n') + '\n',
);
assets.push({
  name: sums,
  bytes: (await stat(artifactPath(sums))).size,
  sha256: createHash('sha256')
    .update(await readFile(artifactPath(sums)))
    .digest('hex'),
});
await writeFile(
  artifactPath(`ProductSpy-${version}-upload-manifest.json`),
  JSON.stringify({ version, assets }, null, 2) + '\n',
);
await writeFile(
  artifactPath(`ProductSpy-${version}-release-notes.md`),
  `ProductSpy v${version} 正式发布候选版（草稿）。\n\n基于08eefad / v0.8.0，保留全部业务、安全配对与便携架构。修复启动器异常停止文件影响服务退出的问题，增加实际可写目录检测、清晰权限提示；候选版本分别校验应用SemVer和Chrome数字版本。完整使用/备份指南随包交付。\n\n实际自动化：${report.unit.files}文件${report.unit.passed}单元测试，${report.e2e.expected} E2E、TypeScript/ESLint/Prettier/生产构建、Portable ${report.portable.checks}项；${report.upgrades.map((row) => `${row.from}→${row.to} ${row.checks}项`).join('；')}；发行ZIP完整CRC/路径/敏感文件/内嵌扩展及SHA校验。${report.screenshots.count}张真实便携工作台截图。Amazon正常访问结果及失败边界见附件报告，Fixture回归不代表真实页面验收。\n\n完整解压Windows ZIP后双击ProductSpy.cmd，无需安装Node.js/pnpm。Chrome手动加载extension并安全配对。更新保留独立用户目录；回退先保存私人原目录副本。普通业务备份不含Key/Cookie/配对凭据。附件含SHA256SUMS、完整报告、发行清单、截图ZIP及使用指南。\n\n工程通过不等于全部真实环境或真实模型验收：付费AI调用0次，正式Chrome、多设备Windows GUI/高DPI/SmartScreen/原生文件选择、原配对小窗口、完整视频播放及真实模型质量有待验收。此版本可以进入正式发布验收，尚不应直接公开发布。\n\n不公开Release，不提交Chrome Web Store，不新增平台、云SaaS、收费、自动发布或视频渲染。\n`,
);
console.log(JSON.stringify({ version, assets }, null, 2));
