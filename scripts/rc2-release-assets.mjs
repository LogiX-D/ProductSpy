import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { artifactPath, zipDirectory } from './packaging/files.mjs';

const fromWeb = createRequire(resolve('apps/web/package.json'));
const JSZip = fromWeb('jszip');
const version = '1.0.0-rc.2';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const report = await json('docs/rc2-hotfix-results.json');
assert(report.passed && report.version === version);
const diagnostics = await json('docs/rc2-popup-diagnostics.json');
assert(diagnostics.finalArtifact.assertions.failed.length === 0);
const screenshots = 'docs/screenshots/rc2-popup';
const expected = [
  'provenance.json',
  ...diagnostics.screenshots.map((item) => item.file.split('/').at(-1)),
].sort();
assert.deepEqual((await readdir(screenshots)).sort(), expected);
for (const item of diagnostics.screenshots)
  assert.equal(sha(await readFile(item.file)), item.sha256);

const screenshotName = `ProductSpy-${version}-popup-screenshots.zip`;
const screenshotPath = artifactPath(screenshotName);
// Refuse to replace an accepted ZIP or mix different content under the same hash.
try {
  await access(screenshotPath);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await zipDirectory(resolve(screenshots), screenshotPath);
}
const zip = await JSZip.loadAsync(await readFile(screenshotPath), { checkCRC32: true });
assert.deepEqual(
  Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir)
    .sort(),
  expected,
);
for (const item of diagnostics.screenshots) {
  const name = item.file.split('/').at(-1);
  assert.equal(sha(await zip.file(name).async('nodebuffer')), item.sha256);
}
const copies = [
  ['docs/rc2-popup-hotfix.md', `ProductSpy-${version}-validation.md`],
  ['docs/rc2-hotfix-results.json', `ProductSpy-${version}-validation.json`],
  ['docs/rc2-popup-diagnostics.json', `ProductSpy-${version}-popup-diagnostics.json`],
  ['docs/release-candidate-guide.md', `ProductSpy-${version}-user-guide.md`],
];
for (const [source, name] of copies) {
  const bytes = await readFile(source);
  const target = artifactPath(name);
  try {
    await writeFile(target, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.deepEqual(await readFile(target), bytes, `Refuse to replace existing ${name}`);
  }
}
const names = [
  report.delivery.portable.file,
  report.delivery.extension.file,
  'release-manifest.json',
  screenshotName,
  ...copies.map(([, name]) => name),
];
const assets = [];
for (const name of names) {
  assert(!name.includes('/') && !name.includes('\\'));
  const bytes = await readFile(artifactPath(name));
  assets.push({ name, bytes: bytes.length, sha256: sha(bytes) });
}
await writeFile(
  artifactPath(`ProductSpy-${version}-release-manifest.json`),
  await readFile(artifactPath('release-manifest.json')),
);
const sums = assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n') + '\n';
await writeFile(artifactPath('SHA256SUMS.txt'), sums);
await writeFile(artifactPath(`ProductSpy-${version}-SHA256SUMS.txt`), sums);
assets.push({
  name: 'SHA256SUMS.txt',
  bytes: (await stat(artifactPath('SHA256SUMS.txt'))).size,
  sha256: sha(await readFile(artifactPath('SHA256SUMS.txt'))),
});
await writeFile(
  artifactPath(`ProductSpy-${version}-upload-manifest.json`),
  JSON.stringify({ version, assets }, null, 2) + '\n',
);
await writeFile(
  artifactPath(`ProductSpy-${version}-release-notes.md`),
  `ProductSpy v${version} — Chrome toolbar Popup P1 Hotfix（草稿）\n\n修复根尺寸viewport自引用导致真实action Popup缩成小框的问题，固定400×420 CSS px，内部滚动。对同意设置读写增加3秒有界等待和卸载清理，失败保持禁止采集。Manifest数字1.0.0.2/name ${version}，权限、配对、队列和业务数据结构保持不变。rc.1原包及Release完整保留。\n\n工程：${report.unit.files}文件${report.unit.passed}单测、${report.e2e.expected} E2E、${report.portable.checks}便携检查、${report.upgrades.length}条实际旧包升级、完整TypeScript/ESLint/Prettier/生产构建/ZIP校验。CFT真实action Popup与受控CSS因果矩阵、四模拟DPR和最终包复测通过，16张实际截图。\n\n状态：fixed, pending native Chrome verification。正式Chrome用户复现已确认，但本轮桌面操控因安全检查无法确认当前URL而终止；没有绕过或伪称修复后人工通过。实际Windows 100/125/150/200% DPI及正式Chrome首次/再次/Amazon/普通页/在线/离线/重启仍需维护者记录。真实收费AI调用0。\n\n完整解压Windows ZIP后双击ProductSpy.cmd。更新保留用户目录；扩展保持原unpacked路径再reload可以保留ID和离线队列，换目录可能需重配，未同步前不要卸载旧扩展。详情见报告与使用指南。\n\n不公开Release，不提交Chrome Web Store。\n`,
);
console.log(JSON.stringify({ version, screenshotCrcVerified: true, assets }, null, 2));
