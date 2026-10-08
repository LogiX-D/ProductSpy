# ProductSpy

本地优先的 Amazon 竞品素材采集与 AI 分析工具。Chrome 扩展识别当前商品，保存到本机 Web 工作台；工作台提供商品库、图片 / 视频详情、营销分析、短视频脚本和生成 Prompt。0.2.0 增加 Windows x64 便携分发，保留原有 Next.js / Manifest V3 架构和安全配对。

仅支持 Amazon。此版本没有用户账号、支付、自动发布、价格监控、其他平台或多人协作。

## Windows 普通用户：不用安装开发工具

1. 获取 `ProductSpy-0.2.0-windows-x64.zip`，**全部解压**，双击 **ProductSpy.cmd**。
2. 启动器使用内置 Node.js，启动本机工作台并打开 **http://127.0.0.1:3000**；不用安装 Node.js、pnpm 或数据库。
3. 在启动窗口点击「打开插件文件夹」，按 Chrome `chrome://extensions` →「开发者模式」→「加载已解压的扩展程序」加载便携包的 **extension** 目录。
4. 在工作台扩展说明中生成一次性配对码，填入插件并「连接工作台」。身份校验保留，配对码 2 分钟有效。
5. 打开 Amazon 商品页，点击插件；首次阅读说明后「同意并开始采集」，再保存并在工作台开始 AI 分析。没有 Key 时是完整 Mock 演示。

启动窗口可打开工作台、插件与用户目录，配置 AI，或「停止并退出」。关闭窗口也会停止服务；重复双击不会新增服务。端口冲突会明确提示，不强制结束其他程序，也不改用插件无法连接的端口。

数据保存在 **`%LOCALAPPDATA%\ProductSpy\data`**，和程序目录分离。AI 设置使用当前 Windows 用户的 DPAPI 保护，日志与运行状态分别位于 `logs`、`runtime`；包中没有 Key 或预置用户商品。更新时停止旧版，将新版解压到另一目录即可沿用数据，建议先备份 `data`。

完整安装、首次配对、AI 设置、异常恢复、备份与更新步骤见 [Windows 首次使用指南](docs/windows-guide.md)。当前没有已发布的 Chrome Web Store 安装入口；Extension ZIP 需要解压加载，不能双击安装，也不会自动修改 Chrome 安全设置。便携包以本地 `artifacts` 产物或发布者实际上传的 GitHub Release 资产为准；不把仓库源代码 ZIP 当成可运行安装包。

本次实际产物、207 项单元测试、5 项 E2E、9 项便携包测试，以及正式 Chrome / GUI 人工验收边界见 [Phase 10 验收报告](docs/phase10-validation.md)。商店材料与截图来源见 [提交材料](docs/store/README.md)。

## 源码开发：环境与安装

需要 Node.js 22.12+（已在 Windows / Node.js 24 验证）、pnpm 10 和 Chrome 120+。Manifest 明确限制最低安装版本；真实浏览器验收使用 Chrome for Testing 156，未逐一测试全部历史版本。所有命令从 `ProductSpy` 目录运行。

```powershell
git clone https://github.com/LogiX-D/ProductSpy.git
cd ProductSpy
pnpm install
pnpm dev
```

打开 **http://127.0.0.1:3000**。开发服务只绑定本机，不开放局域网访问。启动时无需数据库服务器、账号或 AI Key。

## 开发者：构建并安装 Chrome 扩展

```powershell
pnpm build
```

1. Chrome 地址栏打开 `chrome://extensions`。
2. 开启 **Developer Mode / 开发者模式**。
3. 点击 **Load unpacked / 加载已解压的扩展程序**。
4. 选择 `ProductSpy/apps/extension/dist`（包含 `manifest.json` 的目录）。
5. 打开工作台 **http://127.0.0.1:3000**，点击右上角「查看扩展安装说明」（或左侧「安装 Chrome 扩展」），点击「生成配对码」。
6. 复制配对码，打开 ProductSpy Popup，将其粘贴到「工作台配对码」，点击「连接工作台」，确认显示「工作台已连接」。
7. 将 ProductSpy 固定在工具栏，打开 Amazon 商品详情页，等待加载后点击扩展，再点击「保存到素材库」。商品将出现在工作台 `/products`。

配对码有效 2 分钟且只能使用一次；过期或已使用时重新生成。重新配对会替换旧连接，工作台「撤销扩展连接」可取消授权。重新加载扩展后若扩展 ID 改变、换了数据目录或连接已撤销，需要重新配对。未配对或工作台断开时，保存操作会暂存在插件中；配对并启动工作台后点击「重试同步」，无需重新采集已暂存的商品。

扩展快捷键：`Alt+Shift+P`。若被系统或其他扩展占用，可在 `chrome://extensions/shortcuts` 修改。每次重新构建后，需要在扩展管理页点击「重新加载」。Popup 的「AI 分析」会先保存商品，再打开详情的 AI 标签；生成分析需在工作台点击「开始 AI 分析」。

`pnpm build` 同时构建 Extension 与 Next.js。生产启动：

```powershell
pnpm start
```

`pnpm dev` 和 `pnpm start` 不要同时占用 3000 端口。扩展的 localhost 地址固定为 `http://127.0.0.1:3000`。

## Mock 与真实 AI

未设置 Key 时，默认返回完整 Mock 分析；界面和总结明确标注 Mock。它用于演示完整流程，输出受众、痛点、角度与脚本模板，不声称已经验证产品效果。

便携用户在启动窗口「AI 设置」中填写模式、API 地址、模型及自己的 Key，保存后停止并重新启动工作台。源码开发者的真实 AI 配置文件放在 **`apps/web/.env.local`**：

```powershell
Copy-Item apps/web/.env.example apps/web/.env.local
```

编辑文件后重启工作台：

```dotenv
AI_API_KEY=填写你自己的Key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_MODE=auto
```

- `AI_MODE=auto`：有 Key 使用真实服务，否则 Mock。
- `AI_MODE=mock`：无论是否有 Key，都使用演示分析。
- `AI_MODE=real`：强制真实服务，缺少 Key 时返回明确错误。
- `AI_BASE_URL` 可换成 OpenAI-compatible 服务的 API 基础地址，例如 `https://provider.example/v1`。实现调用 `/chat/completions`，使用 `response_format: { type: "json_object" }`；模型需支持此格式。
- Key 只由 Next.js 服务端读取，未使用 `NEXT_PUBLIC_`，不进入扩展或浏览器 bundle。`.env.local` 已被 Git 忽略，示例文件不包含真实 Key。
- 真实服务会收到已采集的商品文字资料。当前分析基于标题、卖点、描述、价格和评分；没有图像 / 视频内容识别。

接口：`POST /api/analyze-product`，body 为完整 `Product`。响应使用统一信封：`{ ok: true, data: ProductAnalysis }` 或 `{ ok: false, error: string }`。服务端验证响应 schema 后保存；失败保留原商品和旧分析。生成过程中商品被重新采集时返回 `409`，避免陈旧分析覆盖新内容。

## 使用流程

1. 保持本地 Web 服务运行，并完成一次工作台与扩展配对。工作台标签页可以关闭。
2. 打开 `amazon.com/dp/ASIN` 等支持的商品页，等待页面加载后点击扩展。
3. 检查标题、价格、ASIN、图片 / 视频数量和评分，再保存。
4. 商品库支持 Grid / List、标题 / 品牌 / ASIN 搜索、来源筛选、删除与打开详情；每 5 秒及恢复焦点时刷新。
5. 详情提供 Gallery、Overview、Media、AI Analysis。缺失字段显示明确提示。
6. Media 可下载单图或全部图片 ZIP；视频仅使用页面公开提供的原始 URL。
7. AI Analysis 展示总结、卖点、受众、购买动机、痛点、优势 / 弱点、Marketing Angles、至少 5 条 Hook、五段脚本、图片及视频 Prompt。Hook、脚本、Prompt 可复制。
8. 刷新页面或重启服务后，商品和分析仍保留。

工作台未启动时，扩展将商品暂存在 `chrome.storage.local` 并标记「尚未同步」；启动工作台后点击「重试同步」。重复采集使用 `amazon + uppercase ASIN` 去重，保留 ID 和创建时间，更新资料与 `updatedAt`。价格、标题、品牌、描述或卖点变化时清除旧分析；其他信息变化不会生成重复商品。

## 架构与数据

```text
Amazon 当前页面
   → activeTab + content extractor
   → 扩展 Service Worker
   → localhost API bridge
   → 本地 JSON Repository
   → Next.js 工作台 + Dexie IndexedDB 缓存
   → AIProvider（Mock / OpenAI-compatible，服务端）
```

Chrome 扩展与普通网页不能直接共享同一个 IndexedDB，因此采用 localhost bridge。权威数据文件：源码开发默认在 **`apps/web/.data/products.json`**；Windows 便携版固定使用独立的 **`%LOCALAPPDATA%\ProductSpy\data\products.json`**，不需要数据库服务器。Web 的 IndexedDB 用于缓存与网络故障时回显。需要备份时停止服务并复制对应数据目录；不要清空该目录或将其提交到 Git。便携版不自动迁移源码 `.data`，迁移步骤见 Windows 指南。

可在 `apps/web/.env.local` 设置 `PRODUCTSPY_DATA_DIR` 指定其他数据目录。文件读写按目录共享事务队列，临时文件写入后原子替换；损坏 JSON 会报错并保留原文件，不会静默清空。此适配器用于单个 Next.js 服务进程，不支持多个进程同时写一个目录。

共享抽象：`ProductRepository` / `ProductStorageAdapter`、`ProductSyncAdapter`、`AIProvider`。已实现 `ExtensionLocalStorageAdapter`、`WebLocalStorageAdapter`、`LocalhostProductSyncAdapter`、`ProductApiRepository` 和 `LocalJsonProductRepository`；后续可增加 Supabase / Postgres adapter。

API 只接受本机 3000 端口，商品读取、写入、分析和媒体下载均需要认证。工作台通过同源 bootstrap 获取 HttpOnly、SameSite=Strict Cookie，会话绑定当前本机 Host；要求浏览器同源 `Sec-Fetch-Site`，跨站请求不能创建会话。客户端只在业务操作尚未执行的 `401` 时续期并重试一次，其他失败不会自动重复写入或 AI 调用。

扩展通过一次性配对码获得随机 Bearer token。服务端只存令牌的 SHA-256，并将其绑定配对时的实际 `chrome-extension://` Origin；任意其他扩展、未配对扩展或只有伪造请求头的请求不能读取或写入素材库。CORS 只向本机工作台与已配对扩展开放业务接口；配对入口允许合法扩展来源，但仍必须验证一次性码。写入另要求 JSON、有效 Origin 和与来源一致的 `X-ProductSpy-Client`。令牌与待同步商品只允许扩展可信上下文访问，内容脚本不能读取。

这些措施保护浏览器来源边界；本机 HTTP 与文件不是 OS 用户隔离。已经能读取当前用户磁盘、控制浏览器或伪造完整本机 HTTP 请求的程序仍在信任边界内。Windows 文件权限继承所在目录的 ACL。不要将服务开放到公网或直接当成公共 API。数据目录中的 `.bridge-credentials.json`、商品文件、浏览器 profile 和 `.env.local` 均属于本机私有资料，不应提交到 Git。完整数据说明见 [PRIVACY.md](PRIVACY.md)。

## 目录

```text
ProductSpy/
├─ apps/
│  ├─ extension/
│  │  ├─ manifest.json
│  │  ├─ src/
│  │  │  ├─ popup/       React Popup
│  │  │  ├─ content/     点击后注入、读取 DOM
│  │  │  ├─ background/  MV3 Service Worker / 消息协议
│  │  │  ├─ extractors/  独立 AmazonProductExtractor
│  │  │  ├─ storage/     离线暂存 / localhost 同步
│  │  │  └─ types/       重导出共享类型
│  │  ├─ tests/fixtures/ HTML 样本
│  │  └─ dist/           Chrome 加载目录
│  └─ web/
│     ├─ .env.example
│     └─ src/
│        ├─ app/         Dashboard、/products、/products/[id]、API
│        ├─ components/  Shell、商品库、Gallery、Media、分析 UI
│        └─ lib/
│           ├─ storage/  Dexie 缓存与 API Repository
│           ├─ server/   文件 Repository、HTTP 与媒体边界
│           └─ ai/       Mock / OpenAI-compatible Provider
├─ packages/shared/src/
│  ├─ types/             唯一 Product / ProductAnalysis 类型来源
│  ├─ schema.ts          输入与 AI 输出 Zod 验证
│  ├─ product.ts         去重 / 合并 / 单调更新时间
│  └─ http.ts            统一客户端请求与错误信息
├─ e2e/                  加载真实构建扩展的 Playwright 测试
├─ scripts/
│  ├─ amazon-smoke.mjs       单页真实采集 / 可选隔离 Mock 完整链路
│  └─ amazon-acceptance.mjs  多品类 / 国家站真实页面验收
├─ docs/phase9-validation.md  Phase 9 当前验收结果
├─ docs/windows-guide.md      普通用户安装、配对、备份与更新
├─ docs/store/                商店文案、权限 / 数据披露、审核复现
├─ artifacts/                 本机构建的分发包、哈希与商店资产
└─ pnpm-workspace.yaml
```

## 解析与媒体限制

`AmazonProductExtractor` 的各字段方法可单独测试。优先 JSON-LD、metadata、已存在的页面数据对象，再使用多个 DOM fallback；不执行页面 script 文本或 `eval`。匹配当前 ASIN，排除可识别的推荐商品结构化数据。价格、评分、评论数量、品牌、描述和媒体均允许缺失。

- 支持共享域名白名单中的 Amazon 国家站与 `/dp/`、`/gp/product/`、`/gp/aw/d/` URL；搜索、列表和验证页面不采集。
- 价格与库存受地区、配送地址、登录、变体和页面加载状态影响；不存在可见价格时显示暂缺。优先使用明确货币文本或结构化 currency 字段；只有裸 `$` 或裸数字而无可靠货币信息时不猜 USD。
- 部分变体、动态 Gallery 和 Amazon 新页面结构仍可能需要增加 fallback；改变变体后建议等待页面稳定再重新采集。
- 视频只提取页面已经公开暴露、能够可靠归属当前商品的 HTTP(S) `.mp4`、`.webm`、`.m3u8`。共享播放器对象和视频数组会包含其他商品、变体或推荐内容；明确 ASIN 不符或缺少足够身份关联时保守留空，不把页面上的所有视频都算作当前商品视频。HLS 可能无法在 Chrome 原生播放，提供原始链接。
- 不绕过 DRM、登录、安全验证或站点保护。媒体 URL 可能过期或无法跨域播放。
- 图片按 URL 保存，不预下载整库。下载 API 只访问 6 个明确 Amazon 图片 CDN 域名，禁止重定向，检查 MIME / 文件签名，单图 10 MiB，ZIP 合计 80 MiB。CDN 下载失败时可打开原图手动保存；ZIP 任意图片失败会明确报错，不生成缺图 ZIP。
- Mock 是演示模板；真实模型输出也需人工核实商品事实和宣传表述。

## 检查与测试

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Vitest 覆盖：JSON-LD / metadata / 页面对象 / DOM、标题、价格、ASIN、图片去重、Bullet Points、评分、评论数量、缺失字段与异常 HTML、推荐商品过滤、并发去重、文件持久化与损坏保护、Dexie、扩展暂存 / 同步、CORS / CSRF、媒体 URL / 类型 / 大小、AI schema、Mock、真实 Provider HTTP 合约、超时、失败保留分析与版本冲突。Windows 生命周期检查 `pnpm test:portable` 需先执行下面的 `pnpm package:windows` 生成完整便携目录；运行前先停止占用 3000 的工作台。

浏览器端到端测试：先停止占用 3000 端口的工作台，然后运行：

```powershell
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
```

E2E 自动启动生产服务，使用独立的 `ProductSpy/.test-data`，不使用默认素材库。加载原始构建 Extension，通过 Chrome 的扩展 action 调试接口授予真实 `activeTab`；不修改扩展权限。Amazon HTML 和下载图片使用确定性 fixtures，覆盖 Popup、一次性配对、采集保存、去重、商品库筛选 / 视图、详情、单图 / ZIP 下载、Mock 分析、复制、刷新保留、离线重复暂存与重试、部分同步失败恢复、旧分析保护、非商品页和删除；另验证匿名读取、伪造扩展凭据与跨站会话请求被拒绝。报告在 `playwright-report/`，E2E 截图和下载证据在 `test-results/`。

真实页面检查（仅读取，不保存，不调用 AI）：

```powershell
pnpm exec node scripts/amazon-smoke.mjs "https://www.amazon.com/dp/你的ASIN"
```

使用 `--save` 可在当前运行的工作台保存该商品并验证 Mock 分析 / 刷新保留；此选项会实际写入当前素材库，只允许 Mock 模式。开发验收时应让服务使用 `PRODUCTSPY_DATA_DIR` 指向测试目录。该检查不绕过 Amazon 验证；站点不可达或返回验证页时会报告未验证。

多品类真实页面验收（仅读取与采集，不保存、不调用 AI）：

```powershell
pnpm exec node scripts/amazon-acceptance.mjs
```

真实页面证据保存在 **`.test-data/phase9-evidence/`**，避免被 Playwright 清理 `test-results/` 时移除；单页链路使用其 `live-workflow/` 子目录。页面 HTML、浏览器 profile、配对凭据及测试商品均仅保留在 Git 忽略的本机目录，提交的报告只包含必要的公开商品结果和限制说明。验证码、地区限制、不可达页面不绕过，也不以 fixture 或 Mock 结果替代真实成功率。

当前验收见 [Phase 9 真实环境报告](docs/phase9-validation.md)，其中分别记录跨品类 / 国家站真实字段、正常颜色变体切换、自动化测试和安全检查。真实 OpenAI-compatible 合约使用本地 HTTP stub 验证；未使用真实 Key 调用收费模型。早期 MVP 验收保留在 [VALIDATION.md](VALIDATION.md)，其单页结果和测试数量是 Phase 8 历史，不代表当前全部覆盖。

Phase 10 分发与上架验收见 [本次报告](docs/phase10-validation.md)，不更改 Phase 9 的历史实页数量或成功率。Chrome Web Store 提交条件和待办见 [商店准备说明](docs/chrome-web-store.md)，可填写文案在 [docs/store](docs/store/README.md)。正式 Chrome 稳定版人工验收、公开下载地址与开发者 Dashboard 配置须如实记录，未提交审核，也不承诺已获商店批准。

## 构建 Windows 便携版与 Extension ZIP

以下仅供开发者 / 发布者运行；普通用户不需要命令行：

```powershell
pnpm install
pnpm build
pnpm package:extension
pnpm package:windows
pnpm test:portable
```

输出在 **`artifacts/`**：

- `ProductSpy-0.2.0-windows-x64.zip`：Windows x64 便携工作台、内置 Node.js、Next.js standalone、启动器和已构建扩展。
- `ProductSpy-0.2.0-extension.zip`：可供 Chrome Web Store 上传的 MV3 扩展，根目录包含 `manifest.json`。
- 构建校验文件及商店图片：名称与哈希以构建实际输出为准。

已取得真实运行截图及 `artifacts/store/asset-provenance.json` 后，可运行 `pnpm package:store` 生成商店材料 ZIP；脚本校验来源、截图尺寸与哈希，不会用模拟页面补齐截图。真实采集工具是 `scripts/capture-store.mjs`，验收时应先启动使用独立测试数据目录的便携工作台并保持 Mock 模式，避免写入自己的素材库。

打包只复制允许的生产文件，不复制 `.env.local`、源码用户 `.data`、浏览器 profile、待同步商品或 AI Key。包中的运行时许可证随包保留；Windows 便携版使用系统 Windows PowerShell 5.1 / WinForms，不引入 Electron。首次构建需要下载或提供 Windows x64 Node.js 运行时，构建脚本会核对运行时完整性。

`test:portable` 使用独立测试目录检查启动、停止、重复启动、端口冲突、持久化、包内容与更新兼容，不向默认用户商品库写入测试数据。它与 Vitest、E2E 都需要实际运行；商店截图不是验收结果的替代品。

## 下一阶段

1. 建立更多国家站、变体和动态视频的实页回归样本，提高采集覆盖率。
2. 增加商品分组、标签与资料导入 / 导出，方便管理更多素材。
3. 增加可编辑分析、营销模板、目标市场语言和多版本脚本，提升创作输出质量。
