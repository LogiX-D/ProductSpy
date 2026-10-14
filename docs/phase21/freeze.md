# Phase 21：冻结 v1.0.0-rc.1 候选版

2026-10-14（Asia/Shanghai）。本页只记录候选版的来源、文件和远程草稿核对，不替代本阶段自动化重跑、正式 Chrome 或 Windows 人工验收。

## 冻结对象

- 初始远程 main、本地 HEAD 与候选版草稿目标均为 `bcf049d45e65ea6da798b53aa6b57b20508927f9`。
- 根目录、Web、扩展、shared 包及共享版本常量为 `1.0.0-rc.1`。Chrome Manifest 的数字版本为 `1.0.0`，显示版本 `version_name` 为 `1.0.0-rc.1`。
- [候选版 Release 草稿](https://github.com/LogiX-D/ProductSpy/releases/tag/untagged-becb755db8d1c15adad2)仍为 draft / prerelease，`published_at` 为空。该链接通常需要相应仓库访问权限。
- [Phase 20 验收报告](../phase20-validation.md)与[机器报告](../phase20-results.json)保留原样。已有 711 项单测、33 项 E2E、13 项便携生命周期和 7 条升级通过结果属于 Phase 20 历史证据；本阶段重跑另行记录。

| 候选文件                              |   字节数 | SHA-256                                                            |
| ------------------------------------- | -------: | ------------------------------------------------------------------ |
| ProductSpy-1.0.0-rc.1-windows-x64.zip | 42529040 | `27c49c6d17e6688d7708158302d5921f3415147ebfae91be63156eac849856c5` |
| ProductSpy-1.0.0-rc.1-extension.zip   |   408531 | `a498b531b634e8b89fe52082f6283cc9d3d8813c4cd7b85e81e9f4d6c214d63f` |
| ProductSpy-1.0.0-rc.1-screenshots.zip |  4625783 | `49232b6cb5372fbf911166ead051020b4c3a5527e3e9319c271064303aae6e14` |

10 个草稿附件（含 SHA256SUMS、发行清单、两份验收报告、安全报告及两份指南）逐一核对本地文件字节数与 SHA-256，并与 GitHub `asset.size` / `asset.digest` 对照。完整元组见[本轮机器结果](freeze-results.json)。SHA256SUMS 的 9 项记录也逐一核对实际附件；校验文件本身由第 10 个 GitHub digest 校验。

既有 10 个 Release 的标签、目标、标题、草稿/预发布/公开时间、说明摘要和全部附件元组与首次只读快照相等，未修改或公开。旧版 v0.2.0 至 v0.8.0 共 18 个 Windows/扩展 ZIP 的本地文件与对应既有远程 digest、字节数相等，保留升级与回退的可追溯来源。机器结果只列必要的发行元数据，不复制 GitHub 作者资料或完整草稿正文。

## 权限与原候选包

冻结扩展仍为 Manifest V3、最低 Chrome 120、模块 Service Worker；权限为 `activeTab`、`scripting`、`storage`，host 权限仅为 `http://localhost/*` 和 `http://127.0.0.1/*`。CSP 保持 `script-src 'self'; object-src 'self';`，没有新增 web-accessible resources。源码 Manifest 与冻结 Extension ZIP 内 Manifest 完全相等。ZIP 完整 CRC、逐文件清单、敏感文件和内嵌扩展检查由独立回归继续执行。

本阶段没有重打同版本 ZIP、覆盖附件、重新上传二进制或修改远程 Release。源码生产构建可以更新开发目录的 `.next` / `dist`；它不能替换作为验收对象的冻结 ZIP。若真实缺陷需要修改产品代码，应递增为新的 RC，保存原候选包和其哈希，不把不同字节称作同一个 rc.1 产物。

## 重复核对方法

从项目根目录执行：

```powershell
# 首次核对。要求此前已只读保存 releases-before.json；初次结果以 wx 独占创建。
node scripts/phase21-freeze.mjs

# 后续核对；不会覆盖初次冻结记录。
node scripts/phase21-freeze.mjs --verify-again

# 最终文档提交并推送后再次实时核对，只保存本机回执，不再改动已提交的公开报告。
node scripts/phase21-freeze.mjs --verify-again --no-public-save
```

初始输入为 `.test-data/phase21/releases-before.json`。脚本只向 GitHub 发送读取请求，重新获取实时 main、草稿及全部 Release；每次保存新的 `.test-data/phase21/freeze-<UTC时间>.json`、远程读取记录和公开脱敏结果 `docs/phase21/freeze-results.json`。初次通过记录另存 `freeze-initial.json`。

`--no-public-save` 只能与 `--verify-again` 一同使用；未知参数、重复参数或单独使用均直接拒绝。该选项保持全部远程读取、哈希核对和严格断言，仍保存新的本机时间戳回执及远程读取记录，但不覆写 `docs/phase21/freeze-results.json`。这样最终推送后的复核无需再修改已提交文档，也不会形成重复提交循环。

`--verify-again` 强制比较初次候选附件 ID/大小/哈希、18 个旧包哈希、所有 Release 状态与附件元组、权限和 Phase 20 报告摘要；不相等就失败。下载计数是只读访问可能改变的统计量，不作为冻结文件身份。后续文档与测试提交可以推进 main，但必须是候选提交的正常后代，且差异仅限文档、测试及明确允许的验收脚本；生产代码、依赖锁与打包器变更不能通过此冻结检查。候选草稿的构建来源目标必须仍为上述完整 SHA；脚本同时记录当时 main 和变动文件，避免把文档提交误称为重新构建了候选包。

不得直接重跑会重写原产物的 `package:*`、`phase20-release-assets.mjs` 或发布命令。本核对不启动工作台、不读取用户资料、不调用模型，也不会把文件一致性写成正式 Chrome、原生 GUI、DPI、SmartScreen、配对小窗口或真实 AI 质量验收通过。
