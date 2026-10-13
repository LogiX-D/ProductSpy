import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { artifactPath, zipDirectory } from './packaging/files.mjs';

const version = '0.7.0';
const report = JSON.parse(await readFile('docs/phase18-results.json', 'utf8'));
assert(report.passed && report.version === version && report.screenshots.count >= 8);
const screenshots = artifactPath(`ProductSpy-${version}-screenshots.zip`);
await unlink(screenshots).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});
await zipDirectory(resolve('docs/screenshots/phase18'), screenshots);
const copies = [
  ['docs/phase18-validation.md', `ProductSpy-${version}-validation.md`],
  ['docs/phase18-results.json', `ProductSpy-${version}-validation.json`],
  ['docs/phase18-ai-quality.md', `ProductSpy-${version}-ai-quality.md`],
  ['docs/content-creation-guide.md', `ProductSpy-${version}-content-guide.md`],
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
for (const nameof of names) {
  const path = artifactPath(nameof);
  assets.push({
    name: nameof,
    bytes: (await stat(path)).size,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  });
}
const sums = `ProductSpy-${version}-SHA256SUMS.txt`;
await writeFile(
  artifactPath(sums),
  `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')}\n`,
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
  `${JSON.stringify({ version, assets }, null, 2)}\n`,
);
await writeFile(
  artifactPath(`ProductSpy-${version}-release-notes.md`),
  `ProductSpy v${version}：AI 模板与营销内容创作工作台。\n\n新增模板管理、白名单变量预览、历史与安全备份；内容方案、脚本/分镜/口播/开场/提示词、人工编辑保护、候选比较与恢复、Markdown/TXT/JSON/文字 ZIP 导出。真实 AI 仍逐次授权，Key 仅服务端管理。保留商品库、素材、竞品对比、安全配对和 Windows 启动器。\n\n验收：TypeScript/Lint/Prettier、60 文件 642 单元测试、27 E2E、生产构建、Windows Portable 10 项、冻结0.6.0→0.7.0升级22项及0.5.2/0.5.1/0.5.0/0.4.0各21项、两份发行ZIP完整性与安全检查通过；8张真实生产界面截图。\n\n使用：完整解压 Windows x64 ZIP，双击 ProductSpy.cmd；Chrome 手动加载 extension 并完成原安全配对。内容指南、测试报告、素材来源边界和 SHA256SUMS 随附件提供。用户数据目录独立于程序目录，更新不清空原资料。\n\n限制：真实模型调用0次，Mock/Stub不能证明真实质量；正式Chrome稳定版、多设备Windows/DPI/SmartScreen、原生目录窗口及真实模型质量仍待人工验收。仅生成文本，不渲染视频、不发布、不新增平台或收费账户。\n\n此 Release 保持草稿，不公开发布，不提交 Chrome Web Store。`,
);
console.log(JSON.stringify({ version, assets }, null, 2));
