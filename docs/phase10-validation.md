# Phase 10：Windows 便携分发与上架准备验收

验收日期：2026-10-09（Asia/Shanghai）。基于 Phase 9 的原有源码继续开发，没有重建项目、引入 Electron、增加账号 / 收费 / 其他电商平台。结果摘要见 [phase10-results.json](phase10-results.json)。

## 已交付

| 产物               | 项目内位置                                                    | 使用方法                                              |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------- |
| Windows x64 便携版 | `artifacts/ProductSpy-0.2.0-windows-x64.zip`，40,317,756 字节 | 全部解压，双击 `ProductSpy.cmd`                       |
| 可直接运行目录     | `artifacts/ProductSpy-0.2.0-windows-x64/`                     | 内置 Node.js 24.14.0，不要求用户安装 Node / pnpm      |
| MV3 Extension ZIP  | `artifacts/ProductSpy-0.2.0-extension.zip`，391,275 字节      | ZIP 根 Manifest；普通用户当前仍需解压并 Load unpacked |
| 商店材料           | `artifacts/ProductSpy-0.2.0-store-materials.zip`              | 文案、披露、审核步骤、真实截图、宣传 PNG、图标及报告  |
| 首次使用与构建说明 | [windows-guide.md](windows-guide.md)、[README](../README.md)  | 普通用户 / 开发者分流，保留安全配对                   |

分发二进制与原始验收 profile 不进入 Git；代码与脱敏报告进入 GitHub。GitHub Release 资产以实际上传状态为准；草稿不能称作审核人员无需登录可下载的公开发行版。未支付费用或提交 Chrome Web Store 正式审核。

Windows ZIP SHA-256：`423108b1446ce5f457d1bfa63e68bb7fe074bc6a0eb897446d2958898439c530`。

Extension ZIP SHA-256：`c2edcf4e81b63e74ad3f5b0a8026d8c00baff27fd3415532aa78883a61c15f79`。

## 分发架构与实际修复

- Next.js `output: standalone` 保留现有工作台。便携包携带官方 Node Windows x64 运行时，构建前校验官方归档 SHA-256。
- PowerShell / WinForms 小启动器提供打开工作台、插件文件夹、用户数据、AI 设置和停止退出。CMD 隐藏控制台；不改变机器持久化执行策略，不自动改变 Chrome 权限。
- 当前 Windows 用户的具名 Mutex 防止重复启动；固定 loopback 3000，遇到其他程序占用时明确报错且不结束它。
- 用户数据默认 `%LOCALAPPDATA%\ProductSpy\data`，AI 设置位于 `settings` 并使用 DPAPI CurrentUser，日志 / 控制状态独立于程序目录。更新和删除程序目录不触碰用户目录。
- Node supervisor 使用 Next 的停止回调，正常释放端口；启动器意外退出时清理自己拥有的服务进程，不结束未知进程。
- **实际打包启动失败已修复**：Windows 下 pnpm / Next 的绝对 Junction 失去依赖上下文，导致找不到 `@swc/helpers`。现在按每个包自己的版本及 peer 依赖物化嵌套 `node_modules`，没有不可移植链接，并拒绝追踪目录外的链接；增加两项回归。
- 修复 AI 设置 URL 校验与后端不一致：拒绝 Query / Fragment，`real` 模式禁止空 Key，`auto/mock` 允许空 Key。
- 首次采集在读取页面之前显示说明并要求主动同意；独立保存同意版本 / 时间，不改变旧商品、队列或令牌。
- 六步首次使用引导、空状态入口、配对倒计时 / 到期重生成、工作台断线恢复提示、重新识别、Mock 说明与中文主要操作。Popup 固定 400×600，产品区滚动，保存 / AI 固定底部。
- 包检查拒绝 `.env`、商品数据库、配对文件、受保护设置、运行状态、profile 与可识别 Key。附第三方原始许可证：78 个依赖条目、131 份 Next 内嵌 notices；归档不含真实 Key。
- 修复实际 ZIP 路径兼容问题：本机旧 .NET 默认压缩输出反斜杠条目，现在逐文件写入标准 `/` 路径；新增真实 ZIP 读写回归，覆盖扩展根 Manifest、中文路径和 Windows 包根前缀。

## 本阶段真实 Amazon 流程

使用**正常公开页面** [CeraVe B00TTD9BRC](https://www.amazon.com/dp/B00TTD9BRC)，没有替换 HTML、网络响应或 DOM，没有登录、处理验证码或绕过地区 / 保护机制。重复采集同一商品只算 **1 个美妆商品**，不把 Phase 9 的 15 个 ASIN 算作本次测试。

浏览器是 **Chrome for Testing 156.0.8078.4**，不是用户安装的正式 Chrome 稳定版。加载实际便携包中的扩展，通过真实 action 授予 `activeTab`，UI 完成首次同意、一次性配对、保存、打开详情和 Mock AI。页面刷新后分析保留。

本次实际值：ASIN B00TTD9BRC，品牌 CeraVe，价格 TWD606.36 / 货币 TWD，评分 4.7，评分数量 148,820，12 张图片、2 个公开视频 URL、5 条卖点、293 字符描述。价格是当前匿名配送上下文的页面值，不按国家站猜 USD；2 个 URL 可能是同一视频的不同编码，未完整解码视频。当前主图在 Popup / 工作台实际显示。

随后**实际停止并重启便携服务**，复用原扩展 profile，已有 Mock 分析从文件恢复；无需重新同意或配对即可再次保存，仍只有 1 件商品，ID / createdAt 不变。全部数据使用独立 `.test-data/phase10-store-live`，没有向默认用户素材库写入验收商品。

验收工具也修复了两个实际定位问题：Amazon 同时有可见与隐藏 `productTitle`，等待可见标题；保存后的按钮改名，布局检查放在点击前。这些是测试工具修复，不算解析器新增 fallback。

## 真实图片材料

| 图片                                           | 尺寸     | 来源                                           |
| ---------------------------------------------- | -------- | ---------------------------------------------- |
| `artifacts/store/screenshots/01-dashboard.png` | 1280×800 | 实际便携工作台，真实公开商品                   |
| `artifacts/store/screenshots/02-library.png`   | 1280×800 | 实际商品库                                     |
| `artifacts/store/screenshots/03-analysis.png`  | 1280×800 | 实际分析页面，界面明确标注 Mock                |
| `artifacts/store/popup-400x600.png`            | 400×600  | 真实 Popup，辅助验收；不可直接作为商店尺寸截图 |
| `artifacts/store/promo-440x280.png`            | 440×280  | 原创 SVG 品牌图形，不是假 UI 截图              |
| `artifacts/store/icon-128.png`                 | 128×128  | 实际扩展图标                                   |

截图已实际查看，未生成或替换界面图，未包含配对码、令牌、Cookie 或 Key。逐图 SHA、浏览器版本和真实 / Mock 来源分别记录在 `asset-provenance.json` 与 `asset-manifest.json`。原始 Chromium profile 不打包。官方尺寸依据见 [商店准备说明](chrome-web-store.md)。

## 自动化结果

实际环境：Windows 11 专业工作站版 x64，10.0.26300；PowerShell 5.1；Node.js 24 / pnpm 10.32.1。

| 命令 / 检查                                      | 结果                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                   | 通过，lockfile 最新                                                                                             |
| `pnpm typecheck`                                 | 通过，strict，全部工作区                                                                                        |
| `pnpm lint`                                      | 通过，0 errors / warnings                                                                                       |
| `pnpm format:check`                              | 通过                                                                                                            |
| `pnpm test`                                      | **22 文件、207 项通过**，保留 Phase 9 原有测试                                                                  |
| `pnpm build`                                     | Extension Vite + Next production / standalone 通过                                                              |
| `pnpm test:e2e`                                  | **5/5 通过**，含 Phase 9 原 4 项与新增首次指南 / 配对到期恢复                                                   |
| `pnpm test:portable --package <ZIP实际解压目录>` | **9/9 通过**，最新交付 ZIP 解压到中文目录后执行                                                                 |
| 打包产物检查                                     | Windows 1862 文件逐一 size / SHA 校验，加清单共 1863；Extension 226 条目，根 Manifest 0.2.0 / MV3，无 SourceMap |

便携测试实证：PATH 不提供用户安装的 Node / pnpm 仍启动；其他监听器不被结束；二次启动保持同 Node PID；完整 Mock API 返回和分析结构有效；正常退出释放端口；DPAPI 文件不含明文测试 Key；重启、中文新目录重装和异常恢复后完整分析 deepEqual、ID / 时间不变；跨路径仍保持单实例。

这里的更新兼容性是**现有 schema 数据在新解压目录的重装兼容性**，没有伪称运行历史安装包或所有未来 schema 迁移。E2E 的 Amazon HTML fixtures 与故障注入单独用于回归，不冒充真实网页结果。真实 AI 仍只验证既有 provider / stub 合约，未调用收费模型。

原始证据（均 Git 忽略）：

- 最终 ZIP / 检查：`.test-data/phase10-final-zip/2026-10-08T17-52-00-074Z/zip-validation.json`。
- 最终便携报告：`.test-data/phase10-portable/2026-10-08T17-52-10-255Z/report.json`。
- 真实采集 / 重启报告：`.test-data/phase10-store/2026-10-08T17-13-23-174Z/`。
- E2E：`test-results/e2e`，独立于真实页面证据。

## 未完成与上架结论

**可交付 Windows x64 便携预览版和商店材料；尚不满足直接正式提交 Chrome Web Store 的完整准备标准。**

1. 当前正式 Chrome 的常用安装路径与 App Paths 注册项均未找到，浏览器连接库存仅有 Codex IAB / MCP Apps。正式稳定版的人工加载、首次配对、真实采集、断线、重启和重装链路仍待验收；CFT 不能替代。
2. 人工双击 / 完整 WinForms 按钮操作、默认浏览器自动打开、高 DPI 及干净 Windows 10 / 11 机器尚待验收。只有 headless 启动和局部 PS 5.1 / 96 DPI GUI 探针，不把这些写成人工通过。
3. 当前是未签名便携 ZIP，不是 MSI / 自动更新系统。Windows 可能提示未知发行者；不要求关闭防护。只支持 x64，最低 Chrome 120 及其他系统未逐版验证。
4. 需要发布无需登录的精确便携包下载地址，确认审核人员能运行 Windows 本机依赖。GitHub 草稿资产不等于公开发行；开发者资格、两步验证、联系信息和 Dashboard 披露由发布者核对。
5. Amazon 验证页、地区可售性、完整视频播放 / 解码仍有 Phase 9 记录的限制；不绕过保护。商品 JSON 未应用级加密；DPAPI 只保护 AI 设置，不能抵御同用户恶意进程。

没有支付商店费用、提交正式审核或宣称审核已通过。继续沿用 [Phase 9 历史报告](phase9-validation.md) 的多品类边界。
