# Phase 16：产品质量验证与问题修复

日期：2026-10-13（北京时间）。源码基线 v0.5.1 / `d13d7ee`，质量修订构建 **v0.5.2**。保留现有 Next.js、MV3、本机 Repository/IndexedDB、Windows 便携包、安全配对及完整分析历史；本阶段没有新增业务模块、其他平台、账号收费、云服务或商店提交。

**工程检查通过，可继续少量封闭测试；尚不能进入公开测试。** 两个真实图书解析 P2 已修复；配对小空白窗口仍待复现。真实 AI 和外部用户验收尚未执行，维护者「已进行了本机测试」的陈述没有被转成未经证据支持的通过率。

## 现状与证据

已核对最新远端源码及 [Phase 9](phase9-validation.md)、[10](phase10-validation.md)、[11](phase11-validation.md)、[12](phase12-validation.md)、[13](phase13-validation.md)、[14](phase14-validation.md)。当前提交仍为 Phase 14 基线；GitHub 没有新 Issue，既有外部反馈 CSV 只有表头，真实 AI 表未填分。没有伪造 Phase 15 记录、测试用户或任何模型质量结果。

维护者自报、2026-10-12 配对报障、三宽度本机诊断及未补齐的人工证据分别见 [证据状态](phase16/evidence-status.md)。自动布局检查只能证明自己的正常 viewport，不代替实际浏览器小窗口、高 DPI、鼠标流程或普通 Windows 设备验收。

## 实际发现与修复

1. **P2 描述格式/控件污染**：图书 DOM 的段落与列表被拼接，混入「阅读更多」。仅在描述字段保留边界并排除已观察控件。
2. **P2 品牌错误**：图书作者/格式 byline 被误作品牌。作者容器退出品牌 fallback，明确品牌仍优先，缺失时不猜测出版社。
3. **验收工具问题**：补测 v0.4.0 时旧排序控件没有新版明确 label，初轮定位失败。修正经过源码核对的旧版定位并保留原失败报告；这不算产品升级丢失。

新增三条 extractor 回归：描述和作者排除用例在旧逻辑实际失败，明确品牌保留用例作为保护检查；修后三条均通过。原数据与权限不变。详细范围、前后实页证据和待复现项见 [Bug 清单](phase16/bugs.md)。没有确认其他新 P0/P1。

## 本轮真实 Amazon 采集

初轮原 v0.5.1 扩展直接打开 **10 个真实页面，10 个完成采集**，覆盖电子、家居、美妆、服装、厨房、图书六类及美国、德国、英国、日本四站。另对 Crocs 正常点击颜色和图书修复后复测，累计三批、13 个快照、12 次主 URL 导航，含重复；**8 个唯一 ASIN**。不是 13 个不同商品，也没有把旧 Phase 9 或合成样本加入成功率。

使用隔离 Chrome for Testing 156.0.8078.4、原生产扩展及真实 action 授予 activeTab。没有账号、代理轮换、网络响应/HTML 替换、验证码处理或保护绕过。本轮没有遇到验证页；不宣称验证页路径通过。

| 初轮字段                                          | 实际核对                                     | 边界                                                                                      |
| ------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ASIN、标题、主图、图库及最高已暴露候选、评分/数量 | 各 10/10 匹配                                | 主图 GET 各通过；不是每张图片都下载或均为 1500px                                          |
| 价格、明确货币                                    | 各 8/8 可见值匹配                            | 另两页当前购买框无价格，不拿推荐/其他变体价补填；TWD 来自当前配送上下文，不按国家站猜货币 |
| 品牌                                              | 9 匹配、图书 1 失败                          | 修后同一书页保守留空；没有把作者或出版社猜为品牌                                          |
| 卖点                                              | 9 匹配、1 页不可用                           | 不把缺失算作成功                                                                          |
| 视频归属                                          | 5 页取得有绑定的 URL，5 页无可靠可用值       | 初轮 9 个 URL 的 HEAD 均 200；不同编码不等于不同视频，未完整播放/解码                     |
| 描述                                              | 8 页正文 DOM 子串匹配，1 页缺失，图书 1 失败 | 修后图书正文 DOM 匹配；商家宣传、完整阅读语义和播放内容仍需人工核查                       |

Crocs 正常可见颜色点击使 `B0014C5S7S → B0FPSBG9CY`，当前价格由不可用变为 `TWD1,595.83`，主图及当前购买框 ASIN同步变化。子变体图库高级审计尚不能完整独立证明，明确记为 unverified。每页同上下文重复提取的 ASIN/标题/价格/图片稳定；**没有向工作台保存这批实页**。实际保存、去重更新和持久化另由隔离 E2E/便携/升级 fixtures 验证，不混作本批真实保存成功率。

初轮两个失败保留在报告；v0.5.2 的单次图书实页复测另列，没有重写旧结果。逐行数据、字段分母、媒体网络和证据哈希见 [真实采集报告](phase16/amazon-results.json)。该文件 `mock:false` 指页面未用 fixture 替换，不是执行真实 AI。

原始真实界面证据见 [图书页面](screenshots/phase16/01-amazon-book.png)。本轮隔离 E2E 的 [桌面配对弹窗](screenshots/phase16/02-pairing-desktop.png)与 [窄屏配对按钮](screenshots/phase16/04-pairing-narrow.png)属于自动化布局截图；不冒充原报障窗口、真实用户或高 DPI 验收。版本、尺寸、来源与 SHA 见 [截图清单](screenshots/phase16/provenance.json)。

## 自动化与兼容性

| 检查                                          | 最终结果                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| 冻结依赖安装 / TypeScript / ESLint / Prettier | 通过，Lint 零警告                                                                 |
| Vitest                                        | 40 文件、471 项通过；保留基线 468 项，增加 3 个真实问题回归                       |
| Production Build                              | Vite MV3 和 Next.js 16.4 standalone 通过                                          |
| Playwright E2E                                | 20 项通过，保留原 17 项，新增 1280/375/320 配对布局检查                           |
| Windows Portable                              | 10 项通过，含无开发工具 PATH、端口保护、单实例、退出、重装、崩溃恢复与 HTTPS 拒绝 |
| v0.5.1 → v0.5.2                               | 实际冻结包间 15 项通过                                                            |
| v0.5.0 → v0.5.2                               | 实际冻结包间 15 项通过                                                            |
| v0.4.0 → v0.5.2                               | 实际冻结包间 15 项通过，包含旧 UI 定位修正后复测                                  |
| 发布 ZIP                                      | 4 项通过：CRC32、原始路径、每文件 SHA、清单、敏感文件/凭据模式及原权限/CSP        |

升级验证使用全新独立数据目录和测试浏览器，先运行实际旧包保存完整商品、人工摘要、分析与历史，以及支持的分组/标签，再用新包读回。商品读取/退出不重写原文件；重新采集、局部生成、同编号重放、恢复版本和重启保留完整历史。

新增跨版本设置检查：用当前 Windows 用户 DPAPI 加密占位 Key/Mock 配置，验证加密文件原字节及全部明确参数保留；原配对文件和旧用量账本在新请求前原字节一致，原扩展令牌仍能认证。真实 UI 保存的日文/日本/Shorts/专业/15 秒、自定义要求、单价、列表与排序偏好跨版本恢复；旧版仅允许新增默认分组/标签筛选，不能丢失已有字段。不是复制真实用户 profile，不发模型请求。

100/500 **合成**商品性能、500 项标签、备份删除恢复和完整分析核对也随 E2E 重新执行通过；详细时间在机器报告。不把单机缓存状态下的耗时当所有普通电脑保证。源码 `pnpm start` 的 standalone 提示是现有测试启动方式的警告；实际便携服务使用 standalone 入口并通过进程测试。

## 数据、设置和回退

v0.5.2 不改存储 schemaVersion 2 或交换 schemaVersion 1，不自动重写用户库。安装后已有图书不会自动更新，主动重新采集保存才改变资料；内容变动将旧分析归档，不丢完整历史，也不自动调用 AI。

旧 v0.5.0/v0.5.1 草稿、资产 SHA/大小/目标提交和两个解压包全部 1,928 文件已核对保留。默认用户 data/settings 文件只做哈希级检查，不读取 Key/商品正文；本机该检查路径没有现存文件，不能以零文件检查冒称真实用户旧库升级通过。实际兼容性证据来自上述完整隔离 fixtures，不操作用户可能在其他目录的资料。

更新前停止旧服务并备份完整用户目录，将新包解压到新目录。JSON 恢复为保留本机重复项的安全合并，不是覆盖式回退；精确回退要使用停止服务时的完整备份。v0.4.0 不识别新版分类存储，需升级前备份；DPAPI 绑定原 Windows 用户，商品 JSON 备份不含设置/配对/用量/浏览器偏好。扩展卸载前同步待保存记录。

## 真实 AI、外部用户和公开测试结论

没有模型、Key、最大请求数和预算的完整授权，真实模型调用 **0**；没有 AI 质量评分、实际费用、人工编辑/试拍时间或商业价值结论。已准备六类有日期和哈希的历史真实商品、八维评估与费用/编辑计时工具，见 [AI 验收准备](phase16/ai-validation-preparation.md)和 [空评分表](phase16/ai-scorecard.csv)。Mock/Stub 只验证契约与流程，不能作为真实模型质量达标证据。

外部参加者和反馈仍为 **0**，未发邀请、未填安装成功率或再次使用意愿。已准备 [3–5 人独立流程](phase16/feedback-process.md)和 [空反馈表](phase16/feedback.csv)。它们不是已经收集的反馈汇总；本轮不创建假 AI 质量报告或假用户反馈报告。

2026-10-13 重查常见 Chrome 稳定版安装路径与 App Paths 没有发现程序。当前是 Windows 11 专业工作站开发机 10.0.26300 x64；正式 Chrome 鼠标安装/配对、普通 Windows 10/11、高 DPI、SmartScreen/杀软提示、真实设置窗口和外部独立日常使用仍需人工证据。配对小空白窗口、变体图库高级审计及完整视频播放也未全部解决。

因此最终结论为 **继续封闭测试，暂不进入公开测试、暂不上架**。工程回归通过与维护者自述不足以改变这些缺失证据；本轮不公开 Release、不支付费用、不提交 Chrome Web Store。

## 复现及产物

所有进程测试需空闲 3000，只停止自己确认创建的服务；不要结束未知监听进程。原始 HTML、profile、令牌/加密 fixture 和商品数据位于被忽略的 `.test-data`，不上传。

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
pnpm test:upgrade --from artifacts/ProductSpy-0.5.1-windows-x64 --to artifacts/ProductSpy-0.5.2-windows-x64
pnpm test:upgrade --from artifacts/ProductSpy-0.5.0-windows-x64 --to artifacts/ProductSpy-0.5.2-windows-x64
pnpm test:upgrade --from artifacts/ProductSpy-0.4.0-windows-x64 --to artifacts/ProductSpy-0.5.2-windows-x64
node scripts/validate-release.mjs
node scripts/phase16-amazon-capture.mjs --output .test-data/phase16-amazon/new-run
node scripts/phase16-amazon-audit.mjs .test-data/phase16-amazon/new-run
```

最后两条会正常访问真实公开 Amazon，不能保证未来同样可达。出现验证或限制即停止，不替换页面。冻结旧包不可用当前源码重建来冒充旧版。Windows/Extension ZIP、报告、测试资料与校验值在 `artifacts/`，实际计数、哈希、证据索引见 [机器报告](phase16-results.json)。普通用户步骤见 [Windows 指南](windows-guide.md)。
