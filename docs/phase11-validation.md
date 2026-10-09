# Phase 11：产品体验深度打磨

验收日期：2026-10-09（Asia/Shanghai），版本 **0.3.0**。基于 Phase 10 的 `1d89e78` 修改现有工作台和扩展，沿用 Next.js / Manifest V3、Repository、配对与本机文件存储；没有新增账号、收费、云端数据库或其他平台。可公开结果见 [phase11-results.json](phase11-results.json)。

## 实际改动

- 统一深色侧栏、青绿色操作、中文文案、边框、字号、留白与键盘焦点；主要文案集中在 `popup/copy.ts`、`workspace-copy.ts`、`analysis-copy.ts`、`ui-copy.ts`。当前只提供中文，为未来国际化保留结构。
- Popup 保留首次同意、配对、断线队列和重新识别。保存后显示「更新素材库」「打开分析」，直接打开已保存分析不再重复保存。主操作固定在底部，400×600 与 400×480 内容可滚动。
- 首页保留三个简明统计和最近商品，移除重复引导；商品库支持网格 / 列表、标题 / 品牌 / ASIN 搜索、来源与分析状态筛选、排序，记住本浏览器偏好。无结果时只有一个清除筛选操作。
- 详情显示概览、素材与 AI 分析；支持方向键 / Home / End 切换，三个 `aria-controls` 始终有对应面板。已删除商品显示空状态，其他网络错误仍保留重试。
- 素材支持图片 / 视频链接复制、单图 / ZIP 下载反馈、进度与取消；保留 CDN 白名单、类型校验和大小限制。
- AI 分析整理为九个中文分区，保留全部十二个数据字段；五段脚本用中文展示，保存仍兼容原来的英文段名。可复制单项、整区、全部文本，保留条目内换行。
- 全字段编辑支持增删条目与校验，至少保留五条开场文案。保存沿用编辑开始时的 `updatedAt`，409 冲突保留草稿，不覆盖其他页面的新版本。
- 草稿仅暂存在当前标签页的 sessionStorage，并校验格式 / 版本 / 长度；浏览器存储不可用时有当前页面内存兜底。切换详情标签或刷新可恢复，关闭编辑提供保存、保留、丢弃。重新生成先确认，失败保留原分析和草稿。
- 手工修改演示分析仍保留 Mock 来源标识；真实生成前显示商品文字会发往用户配置服务的说明。

## 从实际截图发现的修复

1. 保存提示出现后，400×600 Popup 的底部栏遮住统计数字：缩小主图高度，保留文字和按钮尺寸；实际截图工具增加统计边界检查。400×480 保留可见保存操作，内容需要滚动。
2. 剪贴板拒绝后的手动文本框挤压窄屏标题 / 正文：文本框改为独占一行；375px CSS 浏览器探针正文宽 285px，页面无横向溢出。
3. 长分析编辑器保存失败时错误摘要离屏：自动聚焦并滚动到校验 / API 错误，409 仍保留修改。
4. 商品库无搜索结果时两个相同的清除按钮：合并为工具栏的一处。
5. 404 详情一律显示可重试错误：现在显示「商品不存在」。

初次截图还发现 Dashboard 尚在加载以及 Popup 配对后滚动位置不合适。截图工具改为等待实际商品加载完成并复位滚动后重新拍摄；没有将加载画面冒充完成界面。

## 真实运行与截图

本阶段真实采集 **1 个美妆商品**：[CeraVe B00TTD9BRC](https://www.amazon.com/dp/B00TTD9BRC)。重测同一商品不计为多个商品，也不累计 Phase 9 的 15 个 ASIN。使用正常公开 Amazon 页面，无网络响应 / HTML / DOM 替换，无登录、验证码绕过或保护绕过。

运行环境为 Windows 11 x64，内置 Node.js 24.14.0 的实际生产便携包；浏览器为 **Chrome for Testing 156.0.8078.4**。加载包内原权限扩展，通过真实 action 获得 `activeTab`，UI 完成首次同意、一次性配对、采集保存、详情、Mock 分析与刷新后保留。

实际页面值为 TWD607.32 / TWD、12 张图片、2 个公开视频 URL、5 条卖点。货币来自当前匿名配送上下文，不按 amazon.com 猜 USD；视频 URL 可能属于同一视频的不同编码，本次没有完整解码视频。分析使用明确标识的本机 Mock 模板，没有调用付费模型。

全部截图来自本次实际便携工作台；截图无配对码、令牌、Cookie 或 API Key。源图与哈希记录在 [screenshots/phase11/provenance.json](screenshots/phase11/provenance.json)，原始 profile、商品文件和私有运行状态仅在 `.test-data`，不提交。

| 截图                                                        | 尺寸     | 内容                 |
| ----------------------------------------------------------- | -------- | -------------------- |
| [Popup](screenshots/phase11/01-popup.png)                   | 400×600  | 实际采集与保存后状态 |
| [较矮 Popup](screenshots/phase11/02-popup-short.png)        | 400×480  | 主操作仍在可视区     |
| [首页](screenshots/phase11/03-dashboard.png)                | 1280×800 | 三项统计与最近商品   |
| [商品库](screenshots/phase11/04-library.png)                | 1280×800 | 搜索 / 筛选 / 视图   |
| [商品详情](screenshots/phase11/05-detail.png)               | 1280×800 | 图库与基本资料       |
| [素材](screenshots/phase11/06-media.png)                    | 1280×800 | 真实商品图片与操作   |
| [AI 分析](screenshots/phase11/07-analysis.png)              | 1280×800 | 分区阅读与复制       |
| [分析编辑](screenshots/phase11/08-editor.png)               | 1280×800 | 真实可编辑表单       |
| [手机宽度商品库](screenshots/phase11/09-library-mobile.png) | 375×812  | 响应式筛选与卡片     |
| [手机宽度分析](screenshots/phase11/10-analysis-mobile.png)  | 375×812  | 响应式分析导航与阅读 |

## 自动化验收

| 命令 / 范围                                             | 结果                                        |
| ------------------------------------------------------- | ------------------------------------------- |
| `pnpm install --frozen-lockfile`                        | 通过，锁文件未变                            |
| `pnpm typecheck`                                        | 全部通过，strict                            |
| `pnpm lint`                                             | 通过，零警告                                |
| `pnpm format:check`                                     | 通过                                        |
| `pnpm test`                                             | 25 文件、232 项通过，保留 Phase 9 / 10 测试 |
| `pnpm build`                                            | Vite 扩展与 Next.js 生产构建通过            |
| `pnpm test:e2e`                                         | 7 项通过                                    |
| `pnpm test:portable`                                    | 9 项通过（最终包）                          |
| `pnpm test:upgrade --from ...0.2.0... --to ...0.3.0...` | 8 项通过，0.2.0 → 0.3.0                     |
| `node scripts/validate-release.mjs`                     | Windows / Extension ZIP 全量通过            |
| `pnpm capture:experience`                               | 通过，真实商品与 10 张截图                  |

E2E 的 Amazon 内容与图片下载使用确定性 fixture，与真实截图验收分开记录。原有完整链路、去重、离线重复暂存、部分同步失败恢复、旧分析保护、匿名读取 / 伪造扩展 / 跨站写入拒绝等覆盖全部保留；新增草稿恢复、刷新持久化、无效条目阻止保存、并发 409 不覆盖、筛选记忆、键盘标签、复制权限拒绝和 375 / 768 / 1280 布局。

每次 E2E 使用新的 `.test-data/e2e/<时间>`，避免失败重跑被旧测试商品污染；便携、升级、实页验收均使用独立测试用户目录，不操作默认用户素材库。

ZIP 验证读取真实压缩包的中央目录、CRC32、每个文件大小和 SHA-256；Windows 共 1,864 个文件，1,863 条 bundle 清单逐项匹配，扩展 ZIP 共 226 个文件。检查 ZIP 路径、重复项、私有文件与可识别密钥模式；扩展根 MV3、原权限 / CSP、无源码 map，包内扩展与独立 ZIP 一致。当前环境没有真实 AI Key，未声称进行密钥付费调用。

## 产物和复现

最终便携包、扩展和截图包在 `artifacts/`，分发 ZIP 不进入源码 Git。完整安装说明见 [Windows 指南](windows-guide.md)，运行 / 构建命令见 [README](../README.md)。

| 最终产物                           |       字节 | SHA-256                                                            |
| ---------------------------------- | ---------: | ------------------------------------------------------------------ |
| `ProductSpy-0.3.0-windows-x64.zip` | 40,367,396 | `c67112a546ded37e49a12ecfdd546cc80278f7bcf86c2cac54491539ec48faa5` |
| `ProductSpy-0.3.0-extension.zip`   |    392,371 | `03f659fc83c297d1f6326f2884292367a06217eaebb50b802f1b663bde0fb3ca` |
| `ProductSpy-0.3.0-experience.zip`  |    998,619 | `e724cb39a6f69cd35e1d9ab3f356cdbd27488caa0c452d59ffe4e2f9cc4db7fe` |

便携生命周期 9 项验证无开发工具 PATH 的启动、身份验证、未知端口冲突、单实例、正常停止、DPAPI 设置、分析重启持久化、移动 / 重装和启动器异常退出恢复。跨版本另有 8 项检查：实际用 0.2.0 保存完整合成商品与分析，退出后用 0.3.0 读取，完整对象与数据文件保持不变；更新商品后正确使旧分析失效，重新分析和再次重启仍保留全部字段。合成升级商品没有作为真实 Amazon 成功样本统计。

```powershell
pnpm install
pnpm dev
# 开发扩展：pnpm build 后加载 apps/extension/dist
# 普通用户：全部解压 Windows ZIP 后双击 ProductSpy.cmd
pnpm package:windows
pnpm test:portable
pnpm test:upgrade --from artifacts/ProductSpy-0.2.0-windows-x64 --to artifacts/ProductSpy-0.3.0-windows-x64
node scripts/validate-release.mjs
pnpm capture:experience
```

## 限制与待验收

- 本机未找到已安装的正式 Chrome 稳定版；原生桌面操作能力不可用。**正式 Chrome 加载、真实工具栏 Popup / 高 DPI / 普通显示器、双击 WinForms 窗口、窗口退出和交互式 AI 设置仍待人工验收**。Headless Windows 启动器与 Chrome for Testing 的通过结果不能替代这些项目。
- Windows 11 x64 已执行自动化；其他 Windows 版本、ARM64、企业脚本策略与杀软环境未测试。便携程序无商业代码签名，未制作自动更新器。
- 当前只有中文 UI；商品原文、ASIN、API 技术标识和旧格式脚本数据保留原样。没有完整多语言切换。
- 未保存草稿是当前标签页的临时资料；关闭标签、浏览器恢复策略或清理网站数据可能使其丢失，重要修改应保存或复制。当前不提供跨设备草稿或撤销历史。
- 本次只实测一个公开 Amazon 商品，没有重新进行 Phase 9 的多品类 / 国家站批次。动态价格、变体、视频与 CDN 限制沿用已记录的边界。
- 未使用真实 Key 调用外部 AI，Provider HTTP 合约与失败场景由自动化测试覆盖。
- 没有提交 Chrome Web Store。0.2.0 商店素材保留历史版本，不能把它们冒充 0.3.0 当前商店材料；正式上架前还需更新商店截图和复现步骤、解决旧报告列出的发行与审核阻塞。
