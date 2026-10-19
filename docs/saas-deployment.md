# SaaS 开发、测试、生产与恢复

本文件是部署准备方案，不是已部署证明。正式域名、付费资源、生产变更、真实支付和公开上架需另行授权。

## 环境

| 环境     | 数据库                            | 服务地址与 AI                             | 约束                                                      |
| -------- | --------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| 本机开发 | PGlite 磁盘或开发 PostgreSQL      | loopback HTTP，默认 Mock                  | `pnpm dev` 自动配置；PGlite 所有请求串行，仅单进程        |
| 自动测试 | 临时 PGlite + PostgreSQL 受限角色 | 3100、本机 HTTP、Mock/fixture             | `PRODUCTSPY_ENV=test`；独立数据目录/账户，不能接生产库    |
| 预发布   | 独立 PostgreSQL、HTTPS            | 真扩展构建 origin，AI 经授权，Stripe test | 与生产分离的库、Key、Webhook、备份与审计                  |
| 生产     | PostgreSQL 17+                    | HTTPS 域名/反向代理，服务端 AI/支付       | `.env.production` 注入，应用角色无 BYPASSRLS，禁止 PGlite |

PostgreSQL 18.4 Windows 临时实例用于本轮真实网络回归；Linux CI 使用 PostgreSQL 17.11 并已通过实际逻辑备份恢复及 Web/Worker 容器检查。Compose 示例使用 17；原编排的临时 Linux CI 已通过，公网环境仍待验。

## 小内存预发布与无域名 HTTPS

小内存主机应在 Linux CI 或其他构建机器生成与目标 CPU 架构一致的 Web/Worker 镜像，再传输校验过的镜像；不要在 1GB 主机现场安装全量依赖或构建 Next。原 Compose 的 `build` 不代表必须在目标机器构建，但使用预构建镜像时须显式配置 image，并禁止现场 build。实际部署前先检查现有服务、可用内存/swap、磁盘、端口和容器占用；没有实测不能承诺 1GB 稳定运行。

| 服务端配置                      | 省略时默认 | 允许范围  | 小规模预发布候选 |
| ------------------------------- | ---------- | --------- | ---------------- |
| `PRODUCTSPY_DB_POOL_MAX`        | 12         | 1–20 整数 | 每进程 3         |
| `PRODUCTSPY_WORKER_CONCURRENCY` | 2          | 1–10 整数 | 每 Worker 1      |

显式空白、0、负数、小数、科学计数法和越界值会被拒绝，不能靠错误配置静默回退。数据库池在进程初始化时生效，改值后应重启；Web 与 Worker 各自有池。Worker 并发同时约束 dispatch 查询和本轮实际任务数量，显式 batch 参数不能越过配置值；多 Worker 的合计并发仍需单独管理。这些配置不是内存硬限额，仍需测量 RSS、峰值、OOM、重启与任务持久化。

没有自有域名时，可评估精确 `https://<公网IPv4>` origin。Let's Encrypt 已支持受公共信任的短期 IP 证书；[官方 Certbot 指引](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)要求合适版本的客户端、IP 控制权及可访问的 HTTP-01 challenge。需确认 80/443 的既有用途和入站策略，设置自动续期、失败监控与证书更新后的代理 reload。应用预发布也必须使用受信任证书；Let's Encrypt 的 `--staging` 测试证书不满足浏览器信任。代码接受精确 IPv4 HTTPS origin，不等于该服务器的签发、Chrome 或 Stripe Webhook 已验收。

SSH 隧道到 loopback 的开发联调可作临时诊断，但不是公网 HTTPS 或跨物理设备最终验收。任何服务器安装、证书签发、端口或代理修改仍遵循已获授权范围，不接管现有服务。

### 从 CI 取得预构建镜像

获授权的 Ubuntu 24.04 amd64 小内存预发布可使用 CI 镜像包，无须在服务器构建。先给 PR 添加 `productspy-staging-package` label，再 push 触发现有 `synchronize`；仅该 PR 的所有静态、单元、PostgreSQL、恢复、构建、容器、Compose 和浏览器检查成功后，才导出同一 job 已验证的 Web/Worker 镜像。push、手动运行、无 label 或失败的 PR 不产生该包，也不构建额外镜像或推送 registry。

`export-deployment-images.mjs` 只允许 GitHub Linux/default Docker，拒绝错误 revision/平台；以流式 `docker save` → gzip → AES-256-GCM 输出唯一目录，CI 不落盘明文归档、不覆盖旧包。随机 AES 密钥由专用 RSA-4096 公钥以 OAEP-SHA256 包装；公钥位于 `.github/staging-artifact-recipient.pem`，对应私钥须留在仓库/CI/服务器外。artifact `productspy-staging-<run>-<attempt>-<checkout SHA>` 仅保留 1 天，内含密文 `productspy-images.tar.gz.enc`、`deployment-manifest.json` 和 `SHA256SUMS`。manifest 分别记录实际 checkout SHA/tree 与 PR source head，及 Linux/amd64、两镜像 ID/size/revision 和密文 bytes/checksum、加密 envelope 与接收者公钥指纹；GCM AAD 绑定 checkout/tree/head、镜像身份和 envelope。PR merge SHA 可能不同于 head。包不包含环境文件、数据库卷、测试目录或凭据文件，仓库为 public，不能承诺 artifact 私有，只有公钥对应私钥持有者能够认证解密。此为加密测试交付，不推送 registry、不生成 Release，也不是已部署证明。

从可信成功 run 下载并核对 manifest 对应的 checkout/head 后，先在私有本机目录校验密文并认证解密。SHA256 用于传输完整性，不替代来源核验。解密命令只读显式绝对路径私钥，拒绝仓库内密钥、已有输出和不匹配身份；明文只在独立私有临时目录产生，通过 GCM 后才独占创建目标，失败删除自身临时目录。Windows 临时目录设当前用户 SID ACL，POSIX 设 0700/0600。私钥自身也应由持有者保护。

```text
node scripts/saas/decrypt-deployment-images.mjs -i <absolute-private-key.pem> -a <productspy-images.tar.gz.enc> -m <deployment-manifest.json> -o <new-productspy-images.tar.gz>
```

通过已认证 SSH/SCP 向获授权服务器的私有部署目录传输已解密归档和原 manifest，不上传私钥；在同目录保留对应版本 compose.yaml、scripts/saas/app-role.sql 和私有环境文件。服务器加载前检查传输 checksum；SHA256SUMS 对应密文，不能拿它校验解密后归档。随后验证加载的镜像身份：

```bash
set -euo pipefail
# 这里的文件由私有本机通过已认证 SSH/SCP 传输。
docker --context default image load --input productspy-images.tar.gz
python3 - <<'PY'
import json, subprocess
m = json.load(open('deployment-manifest.json'))
assert m['platform'] == {'os': 'linux', 'architecture': 'amd64'}
for image in m['images']:
    actual = json.loads(subprocess.check_output(['docker', '--context', 'default', 'image', 'inspect', image['tag']]))[0]
    assert actual['Id'] == image['imageId']
    assert actual['Size'] == image['size']
    assert actual['Os'] == image['os'] == 'linux'
    assert actual['Architecture'] == image['architecture'] == 'amd64'
    assert actual['Config']['Labels']['org.opencontainers.image.revision'] == image['revision'] == m['checkout']['sha']
print('Loaded image identities match manifest')
PY
export PRODUCTSPY_IMAGE_REVISION="$(python3 -c "import json; print(json.load(open('deployment-manifest.json'))['checkout']['sha'])")"
```

私有 `compose.images.yaml` 使用以下覆盖（Compose 2.24.4+），移除现场构建配置；`up` 另加 `--no-build --pull never`，一次性 `run` 使用 `--pull never`，禁止隐式重建/换镜像。数据库镜像未打包，先显式取得并核对 `postgres:17-bookworm`；数据库不暴露宿主端口。`.env.compose` 仅含管理员 `POSTGRES_PASSWORD` 供 Compose 插值，`.env.production` 仅含受限应用连接及业务配置，`.env.migrate` 仅含管理连接 `DATABASE_URL`；均设私有权限，不能上传 artifact。小规模配置使用每进程连接池 3、Worker 并发 1，并先用明确标注的 Mock AI 验证资源占用。

```yaml
services:
  web:
    image: productspy-web:${PRODUCTSPY_IMAGE_REVISION:?set revision}
    build: !reset null
  worker:
    image: productspy-worker:${PRODUCTSPY_IMAGE_REVISION:?set revision}
    build: !reset null
```

```bash
set -euo pipefail
docker --context default compose --env-file .env.compose -p productspy-staging -f compose.yaml -f compose.images.yaml up -d --no-build --pull never --wait --wait-timeout 120 db
(
  set -a; . ./.env.migrate; set +a
  docker --context default compose --env-file .env.compose -p productspy-staging -f compose.yaml -f compose.images.yaml run --rm --no-deps --pull never -e DATABASE_URL worker node node_modules/tsx/dist/cli.mjs scripts/saas/migrate.ts
)
# 管理员随后按下节初始化 app-role.sql 并交互设定 app 密码；业务环境只保留受限连接。
docker --context default compose --env-file .env.compose -p productspy-staging -f compose.yaml -f compose.images.yaml up -d --no-build --pull never --wait
```

迁移管理员连接只注入一次性迁移容器，不进入常驻 Web/Worker。以上为交付/消费方法，需服务器实际资源、HTTPS、备份和业务链路检查后才能记录部署成功；归档大小不代表运行内存，现有 Worker 镜像含构建依赖，需预留加载时磁盘峰值。

## 数据库初始化

1. PostgreSQL 准备专用数据库与迁移用户。以迁移连接设置 DATABASE_URL 后执行 `pnpm db:migrate`，此命令幂等建表/索引/RLS；源为 `lib/saas/migrations.ts`。
2. 由管理员执行 `scripts/saas/app-role.sql`；交互式设置密码，创建 NOSUPERUSER/NOBYPASSRLS 的 productspy_app。数据库名若不同，同步修改 GRANT CONNECT。
3. 应用 DATABASE_URL 改用 productspy_app，`PRODUCTSPY_AUTO_MIGRATE=0`。不要给应用 DDL、SUPERUSER、BYPASSRLS。启动时不自动扩权。
4. RLS 强制 workspace_documents、subscriptions、usage_events、jobs、capture_events、audit_events 的 user_id；认证/平台表仅由受信服务器代码访问。每租户连接设置 scope，finally 清理，清理失败销毁连接。

生产初始化现在会查询实际 PostgreSQL 角色，拒绝 SUPERUSER、BYPASSRLS 或可切换到这些特权角色的成员身份；不会只信任连接用户名。`PRODUCTSPY_ENV=production` 对独立 Worker 同样生效。生产不能用 `PRODUCTSPY_ALLOW_PGLITE=1` 绕过 PostgreSQL 要求；显式本机 test/development 的构建产物回归仍可使用开发数据库。

`pnpm db:migrate` 使用专用、短生命周期的管理连接，在同一事务及事务级迁移锁内执行 schema；失败回滚，不向应用全局连接池注册该连接。生产 Web/Worker 始终使用受限角色，设置迁移环境开关也不能绕过角色保护。

## 构建和启动

生产模板 `.env.production.example` 复制到 Git 忽略的 `.env.production`；由部署平台注入真实值，绝不提交秘密。`PRODUCTSPY_APP_URL` 必须是精确 HTTPS origin（无路径/参数），与反向代理 Host、扩展构建地址一致。`PRODUCTSPY_ARCHIVE_SECRET` 至少 32 随机字符，用于跨实例历史清理凭证。

```text
pnpm install --frozen-lockfile
pnpm build
node apps/web/.next/standalone/apps/web/server.js
```

standalone 静态资源须复制到对应 `apps/web/.next/static`，Dockerfile 已处理。容器监听 0.0.0.0:3000，宿主只暴露 loopback，由 Caddy/Nginx/平台代理终止 TLS 并保留真实 Host。不要把 PostgreSQL 端口暴露公网。`/api/health` 检查数据库并返 503；`/api/status` 仅返版本、AI mode 标记和状态，无密钥。

`compose.yaml` 提供数据库、Web 与 Worker 准备。先设置管理员密码并启动 db，运行一次迁移与应用角色初始化，再构建/启动 Web 与 Worker；迁移凭证不注入业务容器。Web 的健康检查跟随 PORT（默认 3000）。提交 `997b0a5` 的 [Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39006243043) 已真实构建并运行两种镜像，验证持久队列、Worker 保存结果、Web 重建后持久化及双用户隔离；这不替代 Compose 编排或公网部署验收。

## 后台 AI Worker

工作台提交 `/api/jobs` 后即持久入队，前端轮询自身任务并读取结果；关闭页面不会取消已提交任务。额度、任务与 dispatch 同事务预留；消费复用原分析/对比/内容 pipeline，结果和版本仍写原业务模型。

生产设置 `PRODUCTSPY_JOB_RUNNER=external`，用与 Web 相同的受限 PostgreSQL 应用连接及 AI 环境运行 `pnpm worker`；`pnpm worker --once` 用于单轮诊断。Compose 已提供 worker target。worker 每轮最多处理两项，用户写锁防止不同进程重复执行。已进入 running 的任务不会因进程重启自动重新收费调用，过期状态显示 interrupted；未执行的 queued 任务可由新 worker 接手。

PGlite 不能被 Web/worker 两个进程同时打开；开发默认在 Web 同一进程内调度，任务页可触发持久队列恢复。生产应使用独立 worker + PostgreSQL，不依赖浏览器在线或本机服务。每次模型调用仍受超时与明确授权约束。

## DeepSeek 接入与测试预算

现有兼容器可使用 `AI_BASE_URL=https://api.deepseek.com`、`AI_MODEL=deepseek-flash`、`AI_RESPONSE_FORMAT=json_object`、`AI_TOKEN_PARAMETER=max_tokens`、`AI_TEMPERATURE=omit`。模型名与价格应在真实调用前核对[官方文档](https://api-docs.deepseek.com/zh-cn/)。可设置 `AI_THINKING=disabled` 明确关闭默认思考，避免推理消耗输出上限；`enabled` 开启，`omit`、空白或省略不向其他兼容平台发送该参数。无效值在发起请求前拒绝。此为配置及离线 wire 测试证明，不替代真实 DeepSeek 调用和生成内容质量验证。

`AI_DAILY_REQUEST_LIMIT` 是每用户、UTC 日的真实请求次数，Free/Pro 是每用户、UTC 月额度；两者都不是整个 API Key 的人民币支出封顶。0 不是禁用值。当前没有全局人民币金额预留；超时或失败也可能被服务商计费，不能用成功响应后的估算或请求次数冒称已实现预算硬上限。有限金额的验收应使用独立测试身份、串行少量请求，调用前核对最新价格与余额，为未知费用保留余量并记录每次消耗，不自动收费重试，不开放无预算约束的真实 AI 公共入口。如需程序级金额硬封顶，应另行落实可核验的服务商硬限额或全局预算预留。

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

该恢复检查现通过独立 `verify-restored-app.ts` helper，以实际注册/商品/模板/竞品/内容路由准备合法测试数据。恢复后先核对原 12 表 SQL/checksum/RLS，再通过进程内实际 Request/Response 路由验证正确/错误密码、商品/Mock 历史与合法业务导出、跨账号 404；登录新增会话和限流更新单独记录，其余表必须不变。它不启动 HTTP 服务，不调用真实 AI 或支付，不证明公网或生产账号恢复。源码脚本现纳入常规 TypeScript 检查。

`node scripts/saas/verify-containers.mjs` 仅用于 GitHub Actions Linux 的独立测试数据库。CI 先构建带当前 GITHUB_SHA revision label 的 `productspy-web:ci` / `productspy-worker:ci`，再设置 `PRODUCTSPY_CONTAINER_VERIFY=1` 与受限应用角色的 `PRODUCTSPY_TEST_DATABASE_URL`。脚本拒绝远程数据库、连接 URL 参数和非默认 Docker endpoint；只消费显式测试库，开始前要求无其他 queued 任务。容器名/label 唯一、镜像禁止拉取，数据库配置由进程环境传递；只清理自身容器和合成账号。脚本强制 Mock AI、禁用支付，未触发收费调用或发布镜像。

`node scripts/saas/verify-compose.mjs` 另需 `PRODUCTSPY_COMPOSE_VERIFY=1`，只运行于 GitHub Linux 的本机 daemon，要求 Compose 2.24.4+。使用原 `compose.yaml` 的服务/网络/依赖/数据库卷/worker 命令，以 `!override` 替换生产 env_file 和 Web 端口为本次私有合成文件及 loopback 随机端口，不读取 `.env.production`。数据库无主机端口，业务镜像只用同 job 已构建镜像；临时项目验证内部 db DNS、角色、Mock Worker、Web/DB 容器重建后的同卷数据。清理前核对项目和本次 marker，只删除自己创建的资源和精确临时文件。该脚本 10 项边界测试及 `881c3ec` 的 [实际 Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39015571302) 均通过；3 容器、1 网络、1 卷和私有环境文件清理成功。不把此命令视为部署授权。

实际容器、Linux PostgreSQL 逻辑恢复、真实 Amazon 本机串联已有证据，详见 [验证记录](saas-validation.md)。真实 HTTPS 预发布、正式隐私联系人/保留期限/账户注销、邮件核验/找回、独立 worker 的云端运维、支付沙盒、跨物理设备、真实 AI 及生产恢复演练仍须分别记录结果。2026-10-19 已取得指定 CloudCone 测试主机及容器/数据库/HTTPS 操作授权，实际 SSH、安装与 IP TLS 进展见 [测试部署记录](saas-validation-2026-10-19.md)；正式域名、付费资源、生产服务与公开发布仍需单独授权。未通过的项目不标为最终验收完成。
