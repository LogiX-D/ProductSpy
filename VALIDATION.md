当前验收请见 [Phase 9 真实环境报告](docs/phase9-validation.md)。以下保留 Phase 8 历史记录，测试数量、字段结果及证据路径均为当时状态。

# ProductSpy Phase 8 验收记录

日期：2026-10-08（Asia/Shanghai）。环境：Windows、Node.js 24.14.0、pnpm 10.32.1、TypeScript 5.9.3、Next.js 16.4.0、Vite 7.3.7、Chromium 156 / Playwright 1.64.0。

| 检查                | 结果                                                  |
| ------------------- | ----------------------------------------------------- |
| `pnpm install`      | 成功；后续 `--frozen-lockfile` 也成功                 |
| `pnpm typecheck`    | 通过，strict，包括应用、共享包与 E2E / 测试配置       |
| `pnpm lint`         | 通过，0 warning                                       |
| `pnpm format:check` | 通过                                                  |
| `pnpm test`         | 13 个文件、118 项测试通过                             |
| `pnpm build`        | Extension / Next.js production build 成功，无构建警告 |
| `pnpm test:e2e`     | 2 项通过，自动启动生产服务，独立测试数据目录          |

浏览器端到端使用构建后的原始 Manifest V3 扩展，实际触发 action 授予 `activeTab`，没有增加测试专用 Amazon 主机权限。固定 HTML fixtures 用于可复现测试；图片下载处理使用固定 PNG bytes，CDN 下载边界另由单元测试验证。

已通过的完整链路：识别商品、提取 JSON-LD 与卖点、保存到 localhost、同 ASIN 再保存更新价格且保持一条记录、工作台搜索与列表切换、打开详情、单图下载与 ZIP、Mock 完整分析、至少 5 条 Hook 与复制、五段脚本、刷新保留、离线暂存及重新同步、不支持的页面提示、删除与空状态。

真实页面额外检查：`https://www.amazon.com/dp/B09B8V1LZ3`（Amazon Echo Dot）。读取 13 张图片、6 条卖点、4.7 分、200,634 条评分 / 评论；主图 CDN 返回 HTTP 200 / `image/jpeg`。在独立测试素材库完成扩展保存、详情、Mock 分析与刷新保留，随后清理测试商品。该页面的当前配送地区没有可用价格；视频未可靠提取。

真实 AI Provider 的认证 Header、基础 URL、模型参数和完整响应验证，使用本地 HTTP stub 实际请求验证。未配置真实 Key，未调用收费模型。AI API 失败、无效响应、超时和采集期间版本变化均有测试。

本地证据：

- `test-results/productspy-production-exte-c5c1e-→-persistence-and-downloads/`：Popup、商品库、分析截图及下载的 PNG / ZIP。
- `test-results/live-amazon/report.json`：真实页面字段与主图 HTTP 验证。
- `playwright-report/index.html`：浏览器测试报告。

这些是当时本机的忽略文件，未提交到 Git；`test-results/` 会被后续 Playwright 运行清理，历史路径不保证继续存在。Phase 9 的真实证据改放在 `.test-data/phase9-evidence/`。真实页面检查只代表该页面当时的状态，其他国家站、变体和动态媒体的后续覆盖见 Phase 9 报告。
