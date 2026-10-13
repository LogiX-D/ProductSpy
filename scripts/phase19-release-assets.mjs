import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { artifactPath, zipDirectory } from './packaging/files.mjs';
const version = '0.8.0';
const report = JSON.parse(await readFile('docs/phase19-results.json', 'utf8'));
assert(report.passed && report.version === version && report.screenshots.count === 57);
const screenshots = artifactPath(`ProductSpy-${version}-screenshots.zip`);
await unlink(screenshots).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});
await zipDirectory(resolve('docs/screenshots/phase19'), screenshots);
const copies = [
  ['docs/phase19-validation.md', `ProductSpy-${version}-validation.md`],
  ['docs/phase19-results.json', `ProductSpy-${version}-validation.json`],
  ['docs/phase19-security.md', `ProductSpy-${version}-security.md`],
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
const sums = `ProductSpy-${version}-SHA256SUMS.txt`;
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
  `ProductSpy v${version}：全模块集成与稳定性优化。\n\n商品、素材、竞品、分析、模板和内容流转保留正确身份与历史；参考素材聚合与质量来源选择、商品分析推断引用、更新/删除来源提醒、新方案刷新、完整业务备份及安全恢复、历史归档与明确清理、设置入口与四宽度体验检查。保留旧数据、安全配对和Windows便携架构。\n\n实际验收：TypeScript/ESLint/Prettier、${report.unit.files}文件${report.unit.passed}单元测试、构建后三轮重复、${report.e2e.expected} E2E、生产构建、Windows Portable ${report.portable.checks}项；${report.upgrades.map((row) => `${row.from}→${row.to} ${row.checks}项`).join('；')}；ZIP完整性/敏感文件/权限校验；${report.screenshots.count}张实际便携界面截图。正常访问10个Amazon页面、9主页面+1可见变体成功、1导航超时；描述/视频仍有人工核验边界。\n\n完整解压Windows ZIP，双击ProductSpy.cmd。插件手动加载extension并完成安全配对；无需自行安装Node.js/pnpm。更新沿用独立用户目录，回退应保留升级前副本。普通业务备份不含Key、Cookie或配对凭据。报告、使用指南及SHA256SUMS随附件。\n\n限制：真实付费AI0次，不能把Mock当质量证据。正式Chrome稳定版、其他Windows设备/高DPI/SmartScreen/原生目录、原配对小窗口、视频播放及真实模型质量仍待人工验收；历史归档不是同ID覆盖恢复入口。源码及详细证据见README/Phase19报告。\n\n本Release保持草稿，不公开发布，不提交Chrome Web Store，不增加平台、收费、云SaaS、自动发布或视频渲染。\n`,
);
console.log(JSON.stringify({ version, assets }, null, 2));
