# ProductSpy

本地优先的 Amazon 竞品素材采集与 AI 分析 MVP。Chrome 扩展识别当前商品，保存到本机 Web 工作台；工作台提供商品库、图片 / 视频详情、营销分析、短视频脚本和生成 Prompt。

仅支持 Amazon。此版本没有登录、支付、自动发布、价格监控、其他平台或多人协作。

## 环境与安装

需要 Node.js 22.12+（已在 Windows / Node.js 24 验证）、pnpm 10 和 Chrome。所有命令从 `ProductSpy` 目录运行。

```powershell
git clone https://github.com/LogiX-D/ProductSpy.git
cd ProductSpy
pnpm install
pnpm dev
```

打开 **http://127.0.0.1:3000**。开发服务只绑定本机，不开放局域网访问。启动时无需数据库服务器、账号或 AI Key。

## 构建并安装 Chrome 扩展

```powershell
pnpm build
```

1. Chrome 地址栏打开 `chrome://extensions`。
2. 开启 **Developer Mode / 开发者模式**。
3. 点击 **Load unpacked / 加载已解压的扩展程序**。
4. 选择 `ProductSpy/apps/extension/dist`（包含 `manifest.json` 的目录）。
5. 将 ProductSpy 固定在工具栏，打开 Amazon 商品详情页，点击扩展。
6. 点击「保存到素材库」，然后进入工作台 `/products`。

扩展快捷键：`Alt+Shift+P`。若被系统或其他扩展占用，可在 `chrome://extensions/shortcuts` 修改。每次重新构建后，需要在扩展管理页点击「重新加载」。Popup 的「AI 分析」会先保存商品，再打开详情的 AI 标签；生成分析需在工作台点击「开始 AI 分析」。

`pnpm build` 同时构建 Extension 与 Next.js。生产启动：

```powershell
pnpm start
```

`pnpm dev` 和 `pnpm start` 不要同时占用 3000 端口。扩展的 localhost 地址固定为 `http://127.0.0.1:3000`。

## Mock 与真实 AI

未设置 Key 时，默认返回完整 Mock 分析；界面和总结明确标注 Mock。它用于演示完整流程，输出受众、痛点、角度与脚本模板，不声称已经验证产品效果。

真实 AI 配置文件放在 **`apps/web/.env.local`**：

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

1. 保持本地 Web 服务运行。工作台标签页可以关闭。
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

Chrome 扩展与普通网页不能直接共享同一个 IndexedDB，因此采用 localhost bridge。权威数据文件默认在 **`apps/web/.data/products.json`**，不需要数据库服务器；Web 的 IndexedDB 用于缓存与网络故障时回显。文件存储在本地、保持可备份。需要备份时停止服务并复制 `.data` 目录。不要清空此目录或将其提交到 Git。

可在 `apps/web/.env.local` 设置 `PRODUCTSPY_DATA_DIR` 指定其他数据目录。文件读写按目录共享事务队列，临时文件写入后原子替换；损坏 JSON 会报错并保留原文件，不会静默清空。此适配器用于单个 Next.js 服务进程，不支持多个进程同时写一个目录。

共享抽象：`ProductRepository` / `ProductStorageAdapter`、`ProductSyncAdapter`、`AIProvider`。已实现 `ExtensionLocalStorageAdapter`、`WebLocalStorageAdapter`、`LocalhostProductSyncAdapter`、`ProductApiRepository` 和 `LocalJsonProductRepository`；后续可增加 Supabase / Postgres adapter。

API 仅允许本机 Host 和本机 / Chrome 扩展 Origin。写操作要求 JSON 与 `X-ProductSpy-Client` 请求头。当前本地 MVP 接受任意有效 Chrome 扩展 Origin，没有用户登录或扩展配对认证；不适合直接部署成公共服务。

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
├─ scripts/amazon-smoke.mjs  真实 Amazon 页面只读检查
└─ pnpm-workspace.yaml
```

## 解析与媒体限制

`AmazonProductExtractor` 的各字段方法可单独测试。优先 JSON-LD、metadata、已存在的页面数据对象，再使用多个 DOM fallback；不执行页面 script 文本或 `eval`。匹配当前 ASIN，排除可识别的推荐商品结构化数据。价格、评分、评论数量、品牌、描述和媒体均允许缺失。

- 支持共享域名白名单中的 Amazon 国家站与 `/dp/`、`/gp/product/`、`/gp/aw/d/` URL；搜索、列表和验证页面不采集。
- 价格与库存受地区、配送地址、登录、变体和页面加载状态影响；不存在可见价格时显示暂缺，不伪造价格。
- 部分变体、动态 Gallery 和 Amazon 新页面结构仍可能需要增加 fallback；改变变体后建议等待页面稳定再重新采集。
- 视频只提取页面已经公开暴露的 HTTP(S) `.mp4`、`.webm`、`.m3u8`，不保证所有商品视频可提取。HLS 可能无法在 Chrome 原生播放，提供原始链接。
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

Vitest 覆盖：JSON-LD / metadata / 页面对象 / DOM、标题、价格、ASIN、图片去重、Bullet Points、评分、评论数量、缺失字段与异常 HTML、推荐商品过滤、并发去重、文件持久化与损坏保护、Dexie、扩展暂存 / 同步、CORS / CSRF、媒体 URL / 类型 / 大小、AI schema、Mock、真实 Provider HTTP 合约、超时、失败保留分析与版本冲突。

浏览器端到端测试：先停止占用 3000 端口的工作台，然后运行：

```powershell
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
```

E2E 自动启动生产服务，使用独立的 `ProductSpy/.test-data`，不使用默认素材库。加载原始构建 Extension，通过 Chrome 的扩展 action 调试接口授予真实 `activeTab`；不修改扩展权限。Amazon HTML 和下载图片使用确定性 fixtures，覆盖 Popup、采集保存、去重、商品库筛选 / 视图、详情、单图 / ZIP 下载、Mock 分析、复制、刷新保留、离线暂存重试、非商品页和删除。安全 API 边界另有浏览器请求验证。报告在 `playwright-report/`，截图和下载证据在 `test-results/`。

真实页面检查（仅读取，不保存，不调用 AI）：

```powershell
pnpm exec node scripts/amazon-smoke.mjs "https://www.amazon.com/dp/你的ASIN"
```

使用 `--save` 可在当前运行的工作台保存该商品并验证 Mock 分析 / 刷新保留；此选项会实际写入当前素材库，只允许 Mock 模式。开发验收时应让服务使用 `PRODUCTSPY_DATA_DIR` 指向测试目录。该检查不绕过 Amazon 验证；站点不可达或返回验证页时会报告未验证。

当前验收：类型检查、ESLint、Vitest、Extension 与 Web 生产构建均已实际执行。真实 OpenAI-compatible 请求通过本地 HTTP stub 验证；未使用真实 Key 调用收费模型。真实 Amazon Echo Dot 商品页也已完成采集、保存、详情、Mock 分析和刷新保留，返回 13 张图片、6 条卖点、4.7 分和 200,634 条评分 / 评论；主图地址返回 HTTP 200 / JPEG。该地区页面没有可用价格，未可靠提取视频。这是单页验证，不代表所有 Amazon 页面都已验证。测试商品已清理。完整验收记录见 [VALIDATION.md](VALIDATION.md)。

## 下一阶段

1. 建立更多国家站、变体和动态视频的实页回归样本，提高采集覆盖率。
2. 增加商品分组、标签与资料导入 / 导出，方便管理更多素材。
3. 增加可编辑分析、营销模板、目标市场语言和多版本脚本，提升创作输出质量。
