# Phase 14：封闭测试与真实环境验收

日期：2026-10-09。源码基线为 v0.5.0 / `8064431`，闭测修订版为 **v0.5.1**。本阶段没有新增业务模块，没有公开 Release、提交 Chrome Web Store 或调用收费 AI。

**可以开始少量封闭测试；尚不具备进入公开测试的证据条件。** 已完成工程、分发和真实公开页面检查，但正式 Chrome 稳定版、普通 Windows 10/11 设备、人工鼠标 / DPI / 安全提示和真实测试者反馈仍待验收。不能把本机自动化作为这些项目的通过记录。

## 安装包及敏感数据

原 v0.5.0 草稿与七个原始资产保持不公开，GitHub SHA-256、大小、目标提交及本机原始文件已核对一致。原 Windows / Extension ZIP 通过路径、CRC32、逐文件 SHA-256、清单及已知敏感文件 / 凭据模式检查，解压目录与 Windows ZIP 的 1,928 文件一致。

因为发现真实 P1，闭测改用 v0.5.1。新 Windows ZIP 和独立 Extension ZIP 已构建，继续内置运行时、MV3 最小权限、安全配对、DPAPI 设置保护和独立用户数据。新包四项完整性检查通过。扫描没有发现 Key、私有商品或会话文件；本轮未配置真实 Key，扫描不等于穷尽所有可能的任意秘密。详细范围见 [独立复核](closed-test/package-audit.md)及 [机器报告](phase14-results.json)。

## 实际问题及修复

| 编号     | 等级                 | 修复结果                                                                                                                                                                                |
| -------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PS14-001 | P1，AI Key 传输安全  | 原版允许远程 HTTP。新增测试先实际失败；修正版在 Provider 和 Windows 保存处要求远程 HTTPS，仅保留精确本机 HTTP。实际打包服务拒绝本机陷阱测试地址，请求数为 0，原商品及完整分析文件不变。 |
| PS14-002 | P2，验收工具证据标记 | 性能报告及截图目录仍固定旧版本。改为共享版本并核对服务版本；专项重跑成功，原始截图从冻结 ZIP 恢复。没有改变原发布 ZIP。                                                                 |

未发现其他 P0/P1。完整复现、证据和人工剩余项见 [Bug 清单](closed-test/bugs.md)。这不是“没有任何 Bug”的承诺。

## 自动化结果

| 检查                                       | 实际结果                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| 冻结依赖安装、TypeScript、ESLint、Prettier | 全部通过；ESLint 零警告                                                        |
| Vitest                                     | 40 文件、468 项通过；保留原 455 项，新增 13 项安全回归                         |
| Production Build                           | Next.js 工作台与 Vite MV3 扩展通过                                             |
| Playwright E2E                             | 原 17 项全部通过；修正证据版本后性能专项另 1 项通过                            |
| Windows Portable                           | 10 项通过，含打包服务的 HTTPS 拒绝与原分析保留；PATH 不含已安装 Node.js / pnpm |
| 实际 v0.5.0 → v0.5.1 包升级                | 10 项通过；升级前已保存分组标签、人工摘要与历史，完整资料和重启保持            |
| 实际 v0.4.0 → v0.5.1 包升级                | 10 项通过；旧商品数组读取不改写，首次写入后兼容分类格式                        |
| v0.5.1 发布 ZIP                            | 4 项通过，原权限、CSP、嵌入扩展一致；不含用户数据或配置                        |

所有进程测试使用独立 `.test-data`，只停止自己确认创建的服务，不终止未知 3000 监听进程。便携测试还覆盖端口冲突、重复启动、正常停止、重新安装 / 换目录、DPAPI、启动器崩溃和互斥恢复。陷阱请求使用假的占位 Key 和受控本机服务，即使发生回归也不会访问收费模型。

性能专项再次以 **100 / 500 个合成商品**测试，包含 50 份完整合成分析及历史；真实执行 500 项标签、导出、删除和完整恢复并逐项核对。具体时间见 JSON，不能冒充 500 个真实 Amazon 商品或普通设备性能保证。

## 真实 Amazon 与完整链路

本轮通过未经替换的公开 Amazon 页面直接尝试六类、六个不同 ASIN，**5 件成功采集，1 件美妆页面导航超时**；没有验证码、账号登录、代理轮换、请求替换或保护绕过。使用 Chrome for Testing 156.0.8078.4，不是正式 Chrome 人工操作。

| 类别                  | ASIN       | 结果                                                           |
| --------------------- | ---------- | -------------------------------------------------------------- |
| 电子 / Logitech C920  | B006JH8T3S | 采集及独立字段比较通过                                         |
| 家居 / upsimples 相框 | B0BQR2BQYZ | 采集及独立字段比较通过                                         |
| 美妆 / CeraVe         | B00TTD9BRC | 35 秒导航超时，未采集、未重试                                  |
| 服装 / Hanes          | B00JUM2V4W | 采集及独立字段比较通过；截图等待超时，保留 HTML / DOM 证据     |
| 厨房 / OXO 饼干勺     | B0000CCY1E | 采集及独立字段比较通过                                         |
| 多变体 / Crocs        | B0014C5S7S | 采集通过，当前购买框无价格；未取其他颜色价格；未执行切变体交互 |

字段分母为五件完成采集与独立审计的商品：ASIN、标题、品牌、主图、图库、最高已暴露分辨率、卖点、评分、数量和主图 HTTP 均 5/5 匹配。价格 / 明确货币 4/4 匹配，另 1 件无当前价格；视频 3 件取得匹配 URL、2 件不可靠可用；描述内容均待独立人工审查，不能标为五件内容通过。完整计数和证据哈希见 [实页报告](closed-test/amazon-live-results.json)。未验证所有视频播放和动态变体切换。

另对上述 Logitech **重复复测一件完整业务链路**，不增加独立商品数量：v0.5.1 便携服务启动 → 原生产扩展 → 首次同意 → 真实采集 → UI 安全配对 → 保存 → Mock → 刷新保留 → 自动化操作编辑 UI → 日文开场局部再生保留原摘要 → 历史比较 → 用量显示零真实请求。15 项链路检查通过，取得 16 张运行截图。此轮同款页面视频保守留空，与另一轮不同动态加载结果分开记录，不承诺动态视频每次均可获取。

原始 HTML、隔离 profile、商品稿、令牌及测试数据只在被忽略的本机目录，未提交。公开图像是已检查不含配对码和 Key 的真实运行界面，不进行图像修改。五张代表图及来源：[Popup](screenshots/phase14/01-popup.png)、[商品库](screenshots/phase14/04-library.png)、[Mock 分析](screenshots/phase14/07-analysis.png)、[版本比较](screenshots/phase14/15-version-comparison.png)、[零收费用量](screenshots/phase14/16-local-usage.png)、[来源清单](screenshots/phase14/provenance.json)。

## 人工、真实 AI 与真实用户

- 当前环境是单一 Windows 11 专业工作站开发机，版本 10.0.26300，不是普通 Windows 10/11 设备样本。标准路径及 App Paths 未发现正式 Chrome。鼠标双击 / 退出 / 插件加载 / 保存设置、SmartScreen / 杀毒提示、125% / 150% / 200% DPI 全部人工待验收，见 [人工证据与待办](closed-test/manual-evidence.md)。
- 没有授权 Key、确切模型、请求上限和金额预算；真实收费 AI 调用、实际费用与质量评分全部未执行。已经准备六类真实历史商品引用、事实边界、六维评分、硬失败规则和账单核对表；不把 Mock 护栏当真实模型质量，见 [AI 验收准备](closed-test/ai-validation.md)及 [评分表](closed-test/ai-scorecard.csv)。
- 实际外部测试者 0，反馈 0；安装成功率、首次成功时间、使用 / 付费意愿未计算。已准备 5–10 人流程、空 CSV 和问题模板，尚未发送邀请，见 [真实反馈状态](closed-test/feedback-summary.md)。

## 数据兼容和回退

v0.5.0 → v0.5.1 不改变商品存储、分组标签或 AI 版本格式；原 ID、ASIN、时间、分析和历史完整保留。升级时停止旧服务，把新版解压到新目录，继续使用同一个 Windows 用户的独立数据目录。程序和扩展的待同步缓存是不同边界：改目录 / 重装扩展前先完成同步，不能承诺卸载浏览器扩展后未保存缓存还能恢复。

JSON 恢复是安全合并，重复 ASIN 保留本机完整资料，不能用它做覆盖式精确回退。升级前停止服务并保存完整用户目录，回退前也保存新版目录。v0.4.0 不识别 v0.5 分类文件，需升级前数组备份；DPAPI 设置绑定原 Windows 用户。旧远程 HTTP AI 设置应修正为 HTTPS，不允许以回退安全修复作为长期使用方法。

## 封闭测试材料与公开测试门槛

[完整安装指南](closed-test/install-guide.md)、[逐项清单](closed-test/checklist.md)、[问题反馈模板](closed-test/feedback-template.md)、[5–10 人记录流程](closed-test/feedback-process.md)、[Bug 模板](closed-test/bug-template.md)已准备。草稿下载需仓库权限；其他实际同意参与者由维护者私下提供原包及校验值，不能把草稿链接当作公开下载页。

进入公开测试前，至少补齐正式 Chrome 稳定版、普通 Windows 10/11 设备的主要流程 / 退出 / 数据恢复、实际高 DPI 与安全提示证据，并收集真实封闭反馈，确认没有未结 P0/P1。美妆超时与动态变体 / 视频边界仍需正常环境复测。真实 AI 未获授权时可以继续 Mock 闭测，但不能宣传真实模型的质量或费用。当前结论保持 **封闭测试，暂不公开**。

## 开发者复现

先正常退出自己的 3000 服务，不结束未知服务；冻结旧包不能由当前源码重新构建来冒充旧版本。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:e2e
node scripts/package-windows.mjs
pnpm test:portable
pnpm test:upgrade --from artifacts/ProductSpy-0.5.0-windows-x64 --to artifacts/ProductSpy-0.5.1-windows-x64
pnpm test:upgrade --from artifacts/ProductSpy-0.4.0-windows-x64 --to artifacts/ProductSpy-0.5.1-windows-x64
node scripts/validate-release.mjs
pnpm test:library-performance
pnpm capture:experience https://www.amazon.com/dp/B006JH8T3S
```

最后一条访问真实页面，只运行 Mock 和独立测试库；若网站不可达或出现验证，报告限制，不替换页面或绕过。源码修复、包哈希和具体证据索引见机器报告。
