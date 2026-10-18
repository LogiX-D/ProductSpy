# ProductSpy

**Chrome Extension + 在线 SaaS 工作台 + 云端后端**。采集 Amazon 商品，登录账号后同步到在线商品库，完成分析、竞品比较和内容创作。正式用户不需要 Windows 本地工作台或服务程序。

当前为 SaaS 迁移开发分支，尚未公开部署或上架。现有 Next.js/React 工作台、MV3 采集器和核心业务继续复用。[产品要求](docs/saas-requirements.md) · [代码审计](docs/saas-audit.md) · [开发计划](docs/saas-plan.md) · [部署与恢复](docs/saas-deployment.md) · [验证记录](docs/saas-validation.md) · [PR 审阅](docs/saas-pr-review.md) · [验收矩阵](docs/saas-acceptance-matrix.md) · [SaaS 扩展发布准备](docs/saas-store/README.md)。

## 开发运行

Node.js 24、pnpm 10.32.1；从仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:3000`，注册账号。无 DATABASE_URL 时开发启动器使用磁盘 PGlite（`.data/saas-development`）；这是单进程开发 PostgreSQL，不是生产部署。未配置 AI Key 时默认 Mock，界面标注演示。支付未配置时保持 Free 并显示原因。

已具 PostgreSQL 时设置 DATABASE_URL，用迁移角色执行 `pnpm db:migrate`，再使用受限应用角色运行。生产不得使用 PGlite 或超级用户，详细步骤见部署文档。

## Chrome 开发扩展

```powershell
pnpm --filter @productspy/extension build
```

1. Chrome `chrome://extensions` 开启开发者模式，加载 `apps/extension/dist`。
2. 在扩展打开 SaaS，注册/登录账户；工作台「扩展连接」填入扩展 ID，生成 2 分钟一次性授权码，粘贴到扩展登录。
3. 阅读云端数据说明并同意后，在 Amazon 商品详情页采集并保存。失败会进入当前账号队列；可重试，后台也会有限退避重试。401 暂停等待重新授权，429 遵循冷却，永久错误保留提示。
4. 打开商品库、详情与 AI 分析。真实 AI 仅由工作台在明确确认后发起，密钥只在服务器。

默认扩展仅访问本机开发地址。生产构建必须指定实际 HTTPS origin：

```powershell
$env:VITE_PRODUCTSPY_APP_URL='https://your-authorized-domain.example'
$env:VITE_PRODUCTSPY_ENV='production'
pnpm --filter @productspy/extension build
```

以上示例不是已部署站点。构建后核对 manifest host_permissions；正式域名、公开发布和商店上架另行授权。权限和登录行为详见 [扩展 SaaS 说明](apps/extension/SAAS.md)。

## 业务与套餐

- 商品库/详情、组合搜索筛选、标签分组、导入导出、浏览器图片/视频下载。
- 商品分析及版本、竞品对比、模板、AI 内容计划、人工编辑与历史恢复。
- 账号/密码、持久会话、跨账户隔离、任务记录与失败状态、用量、账单入口。
- Free：50 商品、UTC 月 10 次 AI；Pro：5,000 商品、UTC 月 500 次 AI。失败/中断也计，幂等重放不重复计。套餐由服务器检查，不能通过浏览器修改升级。
- Stripe Checkout/Portal/Webhook 已有集成；离线 SDK 签名测试、支付沙盒和真实交易分别验收，不以本机测试宣称支付已通过。

## 验证

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
node scripts/saas/build-test-extension.mjs
pnpm test:saas:e2e
```

SaaS E2E 使用 3100 端口、独立数据库、真实 MV3 和 HTTP；Amazon fixture 与 Mock AI 明确标记。网络 PostgreSQL 受限角色回归：先用迁移角色建表/授权，再设置 `PRODUCTSPY_TEST_DATABASE_URL` 并运行 `pnpm test:postgres`。CI 配置会执行检查与构建，但需实际运行结果才能声称远端 CI 通过。

AI 已接入持久后台队列。生产设置 `PRODUCTSPY_JOB_RUNNER=external` 并运行 `pnpm worker`；开发 PGlite 使用同进程 runner。独立 Node worker 的实际 PostgreSQL 回归与 Mock 结果分开记录，详情见部署文档。

`pnpm build:webpack` 使用 Next.js 支持的 Webpack 构建同一 SaaS 和扩展，供默认 Turbopack 在特定环境停滞时交叉验证；不增加依赖、不改变业务接口。2026-10-18 本机 Turbopack 停在 compile，Webpack 已完成产物构建，具体限制和本轮结果见验证记录。

## 历史回退

原本地 v1.0.0 基线为 `b83027a`，独立分支 `codex/baseline-v1-before-saas`；[历史 README](docs/legacy-v1-readme.md)、Windows 源码和旧发行证据保留。`pnpm dev:legacy` 供开发兼容回归；生产产品目标始终是在线 SaaS。完整 legacy 业务备份可用 `pnpm db:import-legacy <backup.json> <user-id>` 预览，显式 `--commit` 才导入，不修改源文件或覆盖已有资料。
