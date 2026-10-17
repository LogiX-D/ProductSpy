# SaaS 开发、测试、生产与恢复

本文件是部署准备方案，不是已部署证明。正式域名、付费资源、生产变更、真实支付和公开上架需另行授权。

## 环境

| 环境     | 数据库                            | 服务地址与 AI                             | 约束                                                      |
| -------- | --------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| 本机开发 | PGlite 磁盘或开发 PostgreSQL      | loopback HTTP，默认 Mock                  | `pnpm dev` 自动配置；PGlite 所有请求串行，仅单进程        |
| 自动测试 | 临时 PGlite + PostgreSQL 受限角色 | 3100、本机 HTTP、Mock/fixture             | `PRODUCTSPY_ENV=test`；独立数据目录/账户，不能接生产库    |
| 预发布   | 独立 PostgreSQL、HTTPS            | 真扩展构建 origin，AI 经授权，Stripe test | 与生产分离的库、Key、Webhook、备份与审计                  |
| 生产     | PostgreSQL 17+                    | HTTPS 域名/反向代理，服务端 AI/支付       | `.env.production` 注入，应用角色无 BYPASSRLS，禁止 PGlite |

PostgreSQL 18.4 Windows 临时实例曾用于本轮真实网络回归；Compose 示例使用 17。容器版本仍需实际构建/运行验证，不把跨版本推断写成已测结论。

## 数据库初始化

1. PostgreSQL 准备专用数据库与迁移用户。以迁移连接设置 DATABASE_URL 后执行 `pnpm db:migrate`，此命令幂等建表/索引/RLS；源为 `lib/saas/migrations.ts`。
2. 由管理员执行 `scripts/saas/app-role.sql`；交互式设置密码，创建 NOSUPERUSER/NOBYPASSRLS 的 productspy_app。数据库名若不同，同步修改 GRANT CONNECT。
3. 应用 DATABASE_URL 改用 productspy_app，`PRODUCTSPY_AUTO_MIGRATE=0`。不要给应用 DDL、SUPERUSER、BYPASSRLS。启动时不自动扩权。
4. RLS 强制 workspace_documents、subscriptions、usage_events、jobs、capture_events、audit_events 的 user_id；认证/平台表仅由受信服务器代码访问。每租户连接设置 scope，finally 清理，清理失败销毁连接。

## 构建和启动

生产模板 `.env.production.example` 复制到 Git 忽略的 `.env.production`；由部署平台注入真实值，绝不提交秘密。`PRODUCTSPY_APP_URL` 必须是精确 HTTPS origin（无路径/参数），与反向代理 Host、扩展构建地址一致。`PRODUCTSPY_ARCHIVE_SECRET` 至少 32 随机字符，用于跨实例历史清理凭证。

```text
pnpm install --frozen-lockfile
pnpm build
node apps/web/.next/standalone/apps/web/server.js
```

standalone 静态资源须复制到对应 `apps/web/.next/static`，Dockerfile 已处理。容器监听 0.0.0.0:3000，宿主只暴露 loopback，由 Caddy/Nginx/平台代理终止 TLS 并保留真实 Host。不要把 PostgreSQL 端口暴露公网。`/api/health` 检查数据库并返 503；`/api/status` 仅返版本、AI mode 标记和状态，无密钥。

`compose.yaml` 提供数据库与 web 准备。先设置管理员密码并启动 db，运行一次迁移与应用角色初始化，再构建/启动 web；迁移凭证不注入 web。不要仅因 Compose 文件存在就声明已验证 Docker/云端部署。

## 后台 AI Worker

工作台提交 `/api/jobs` 后即持久入队，前端轮询自身任务并读取结果；关闭页面不会取消已提交任务。额度、任务与 dispatch 同事务预留；消费复用原分析/对比/内容 pipeline，结果和版本仍写原业务模型。

生产设置 `PRODUCTSPY_JOB_RUNNER=external`，用与 Web 相同的受限 PostgreSQL 应用连接及 AI 环境运行 `pnpm worker`；`pnpm worker --once` 用于单轮诊断。Compose 已提供 worker target。worker 每轮最多处理两项，用户写锁防止不同进程重复执行。已进入 running 的任务不会因进程重启自动重新收费调用，过期状态显示 interrupted；未执行的 queued 任务可由新 worker 接手。

PGlite 不能被 Web/worker 两个进程同时打开；开发默认在 Web 同一进程内调度，任务页可触发持久队列恢复。生产应使用独立 worker + PostgreSQL，不依赖浏览器在线或本机服务。每次模型调用仍受超时与明确授权约束。

## Stripe 配置

默认未配置，Free 可用，账单入口说明不可用。配置 test secret、固定 Pro price 和 test webhook secret；事件采用 snapshot `customer.subscription.created/updated/deleted`，端点 `/api/billing/webhook`。原始正文使用官方 SDK 验签，校验 test/live 环境，事件去重；用户写锁内读取 Stripe 当前订阅状态，按客户、订阅、价格、quantity 和状态授予权益。Checkout 成功跳转本身不授予 Pro。

结算请求在调用 Stripe 前将 UUID、完整请求参数及起始时间持久化到用户订阅行。重试复用原参数和幂等键；已知页面通过 provider retrieve 核对归属和状态，未过期页面复用，已过期或关联订阅已确认终止后才新建。新建前核对该客户全部订阅；未结清、暂停、未完成或多个存续订阅都不能再次购买。分页不能完整核对时停止新建。此设计依据 [Stripe 幂等请求](https://docs.stripe.com/api/idempotent_requests)、[Checkout Session 状态](https://docs.stripe.com/api/checkout/sessions/object) 和 [订阅列表](https://docs.stripe.com/api/subscriptions/list)。

Stripe 的幂等键至少 24 小时后可能被清理，因此本应用对丢失响应且没有已知 session ID 的请求只允许在 23 小时内复用；超时返回 409，不换键自动重发。维护者应在 Stripe 的请求日志/结算记录中按原幂等键和所属客户核对结果，再恢复已确认的 session 关联。不能在结果未知时清空该记录。数据库迁移为现有 subscriptions 增加四个 nullable 字段，仍由原 RLS 保护；上线前使用迁移角色重新执行 `pnpm db:migrate`。

Webhook 延迟时，用户可在账单页点击“刷新订阅状态”，经仅限已登录网页的 `POST /api/billing/reconcile` 核对服务端绑定客户和 provider 的最新状态。客户端提交的用户、套餐、订阅编号不授予权益；有效客户/owner、单项 Pro price、quantity=1、active/trialing 及未来有效期全部成立才授予 Pro。旧订阅的终止事件不降级新订阅；重复签名事件在读取 provider 前确认已处理，provider 暂时不可用时仍可安全确认重放。

真实 secret 还需要显式 `PRODUCTSPY_ENABLE_LIVE_BILLING=1`，必须先有单独用户授权。测试信用卡/真实付款数据不落仓库或知识库。沙盒流程须实际完成结算、Webhook、Pro、续费/取消/失败再验收；本轮离线签名模拟不替代该过程。

## 业务数据迁移

保留 `%LOCALAPPDATA%/ProductSpy/data` 原目录，先在旧稳定版本导出完整业务 JSON。不要读取/搬运 DPAPI AI 设置、Cookie、扩展旧 token 或把它们导入 SaaS。

```text
pnpm db:import-legacy <business-backup.json> <existing-saas-user-id>
pnpm db:import-legacy <business-backup.json> <existing-saas-user-id> --commit
```

默认只预览并打印源 checksum、数量、冲突；commit 绑定已存在账号、保留已有资料、遵循套餐上限、数据库事务写入。源文件不修改。不能把真实私人资料迁入自动测试账户；需先确定真实归属账户。旧浏览器/扩展无 owner 队列不能自动认领，需原账号恢复或重新采集。

## 备份与恢复策略

- 每日 PostgreSQL `pg_dump --format=custom`，独立备份角色（能读全部业务需专用权限），保存加密副本到与数据库不同故障域；按业务要求确定保留期限和访问审计。备份包含密码/会话哈希，不能公开。
- 对目标 RPO/RTO 有要求时启用托管 PostgreSQL PITR/WAL；初始建议 RPO 24h/RTO 4h，属于待运维确认目标，未声称已达到。
- 每次迁移前先备份；用 `pg_restore --exit-on-error` 恢复到新隔离数据库，执行 schema、记录数量、双用户隔离、登录/导出/AI 历史和应用健康检查，再切换连接。不对生产执行 `--clean` 或覆盖恢复。
- 用户业务导出/恢复使用已有 `/api/workspace-backup`；还原先预览 revision/冲突/上限，再原子提交，多文档无部分写。套餐与登录凭据不属于业务导入可授予字段。
- 扩展保留账户队列和错误状态，网络恢复有限重试；401 暂停，429 冷却；AI 中断标为 interrupted，额度保留，不自动收费重试。
- 服务器日志仅记录状态/错误类型和必要审计动作，不打印密钥/密码/完整请求正文。生产需要集中日志、告警、过期会话/授权码和审计保留清理任务；当前基础日志不替代完整运维平台。

## 发布前继续项

### 本机手动验收命令

`node scripts/saas/verify-live-workflow.mjs` 要求先完成构建及 `node scripts/saas/build-test-extension.mjs`，并显式设置 `PRODUCTSPY_TEST_DATABASE_URL` 为现有本机空测试库（库名必须 `productspy_live_*`，连接无查询参数/fragment，应用角色无 SUPERUSER/BYPASSRLS）。脚本仅监听 loopback 3100、强制 Mock AI、使用真实 Amazon 和独立 worker；自动停止自身 Web 进程并清理其注册的合成账号。不会接管已有 3100 服务；外部 Amazon 不可用时如实失败，不回退 fixture，因此不作为常规 CI 的外网依赖。

`node scripts/saas/verify-logical-recovery.mjs` 要求 `PRODUCTSPY_TEST_ADMIN_DATABASE_URL` 与 `PRODUCTSPY_TEST_DATABASE_URL` 显式指向同一本机临时集群，使用不同的管理员及受限应用角色；设置 `PRODUCTSPY_LOGICAL_RECOVERY_ALLOW_CREATE=1` 和含 `pg_dump`/`pg_restore` 的 `PRODUCTSPY_PG_BIN`。管理员仅用于该临时集群的 CREATEDB/备份读取，切勿授予应用角色这些权限。脚本不 dump 环境变量所指的已有库，只创建唯一源/目标库并种合成记录；拒绝覆盖、`--clean`、远程地址和 URL 参数，清理前核对自身数据库 marker/owner。凭据通过环境传递，不放工具 argv 或报告。

恢复采用 `--no-owner --no-acl`，随后显式对受限应用角色恢复 GRANT 并验证 RLS；真实运维也需单独审核恢复后的角色与授权。本机原始报告、custom dump 和浏览器 profile 留在忽略的 `.test-data`，不能当作公开附件或生产加密备份。测试命令不会证明云端灾备能力。

真实 HTTPS 预发布、容器与 Linux PostgreSQL 验证、正式隐私联系人/保留期限/账户注销、邮件核验/找回、独立 worker 的云端运维、支付沙盒、跨物理设备、真实 Amazon 与 AI，以及数据库恢复演练必须分别记录结果。未通过的项目不标为最终验收完成。
