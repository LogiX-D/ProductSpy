# SaaS 本轮验证与交付记录

日期：2026-10-17（Asia/Shanghai）。实现提交 `18a4b8f`，开发分支 `codex/saas-migration`；原始基线 `b83027a` / `codex/baseline-v1-before-saas`。机器记录见 [JSON](saas-validation.json)。**已通过与待执行的验证分别列明，正式云端验收仍未完成。**

## 实际执行

| 验证                                             | 结果                             | 证明范围                                                                 |
| ------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------ |
| TypeScript / ESLint / Prettier / diff whitespace | PASS                             | 当前代码静态检查                                                         |
| `pnpm test`                                      | 87 files，882 PASS，4 SKIP / 886 | 原业务及 SaaS 单元/集成；4 项网络数据库专属测试由下一项单独执行          |
| `pnpm test:postgres`                             | 44/44 PASS                       | 实际 PostgreSQL 18.4、pg TCP 驱动、无 superuser/BYPASSRLS 应用角色       |
| `pnpm build`                                     | PASS                             | MV3 扩展及 Next.js standalone 生产构建                                   |
| `pnpm test:saas:e2e`                             | 2/2 PASS                         | 真实加载 MV3、真实本机 HTTP/数据库、Amazon HTML fixture、Mock AI         |
| 实时 Amazon 读取                                 | CAPTURED，HTTP 200               | 实际 MV3 从 B09B8V1LZ3 采集标题、9 图、6 卖点；无视频；未上传/分析       |
| PostgreSQL 服务重启                              | PASS                             | 测试商品在原数据库停止/启动后 checksum 一致                              |
| 停机物理副本恢复到独立实例                       | PASS                             | 55433 恢复实例数据 checksum 一致，另一用户 scope 返回 0 条               |
| legacy 导入 CLI                                  | PASS                             | 独立进程预览不写库，commit 归属目标账号，源 backup checksum 不变         |
| Stripe 离线合同与结算恢复                        | 25/25 PASS                       | 9 项含官方 SDK 签名的 Webhook 合同及 16 项结算/核对；提供商 HTTP 为模拟  |
| 真实 Amazon 串联验证                             | 本机 PASS                        | 实际 MV3 上传到 PostgreSQL、独立 worker 保存 Mock 分析、重启后另会话查看 |
| PostgreSQL 逻辑备份恢复                          | 本机 PASS                        | custom dump → 独立空库 restore；12 表 checksum、6 表 RLS、跨用户写入拒绝 |
| Docker Web / Worker 实际运行                     | Linux CI PASS                    | 两个非 root 镜像、随机 PORT 健康、独立 worker、销毁重建后数据与隔离一致  |

PostgreSQL 专属回归包括账户/持久会话、同 ASIN 跨用户隔离、详情/历史/备份授权、一次性授权码来源绑定、扩展最小权限、采集幂等、Free/Pro 和导入超限回滚、改密撤销、已认证排队请求的撤销竞态、PG 写锁与无阻塞读取、RLS 连接清理、持久队列、独立 Node worker 和 CLI。

独立 worker 测试在创建请求结束后启动另一个 Node 进程消费数据库队列并保存 Mock 分析；相同请求不重复预留额度。生产必须运行 worker，PGlite 开发使用单进程 runner。服务中断的 running 任务不自动重新收费调用；未执行的 queued 任务可以恢复消费。

浏览器链路 1：网页注册 → 授权实际 MV3 → fixture 页面真实提取 → HTTP 上传 → 商品库 → Mock 分析保存 → 第二隔离浏览器查看 → 另一账户不可读 → 真实浏览器断网/恢复队列。链路 2：注册 → 商品详情 → Mock 分析 → 内容计划与 Mock 生成 → 任务/套餐/账号 → 375px → 退出换账号无旧资料。

截图：

- [已保存的 Mock 分析](screenshots/saas/saved-mock-analysis.png)
- [扩展采集并登录](screenshots/saas/extension-captured.png)
- [375px 账号页](screenshots/saas/account-mobile.png)

截图仅为合成商品/测试账户，商品图用 fixture 占位；不是实际素材质量证明。实时 Amazon 原始 HTML、浏览器 profile、追踪与数据库均留在忽略的测试目录，不公开账户 token 或正文证据包。

## standalone 产物与远端 CI

`node scripts/saas/verify-standalone.mjs` 已在本机直接启动构建产物的 `server.js`，使用临时真实 PostgreSQL 的受限角色，验证健康、注册、Secure/HttpOnly Cookie、商品保存与持久化、队列、独立 worker、Mock 结果及退出。内网请求使用 Node HTTP 模拟边缘代理的 Host/Origin；不是公网 HTTPS/TLS 或 Docker 运行证明。最初 fetch 忽略自定义 Host 导致 403，改用可控制 Host 的 HTTP 测试客户端后通过，没有放宽服务器来源校验。

提交 `997b0a5` 的 [GitHub Linux / PostgreSQL / Docker CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39006243043) 已实际成功，包含 typecheck、lint、format、unit、真实 PostgreSQL、构建、实际 standalone + 独立 worker、两个 Docker 镜像构建/运行及 MV3 E2E。该提交当时受限角色 PostgreSQL 为 42/42。Linux 全量单测为 842 PASS / 13 SKIP（含 10 项 Windows 专属测试），浏览器 2/2。逻辑恢复也已在 PostgreSQL 17.11 + pg_dump/pg_restore 17.11（Ubuntu PGDG）通过。后续提交的状态以 [PR #1 checks](https://github.com/LogiX-D/ProductSpy/pull/1/checks) 为准，不把旧提交绿灯套用到新提交。

`scripts/saas/verify-containers.mjs` 实际运行本次构建的 `runtime` / `worker` 镜像，核对镜像 revision 与非 root 用户。Web 在随机 PORT 上由 Docker HEALTHCHECK 报 healthy；HTTP 注册/保存商品后，任务在 worker 启动前保持 queued，独立 worker 容器退出 0 并保存分析历史。销毁 Web 容器后用相同镜像重建，重新登录，商品/历史 checksum 一致；另一个账号库为空，商品/历史/任务均返回 404。两个合成账号及自建容器已清理。该检查也发现并修复原健康检查写死 3000 的问题。它证明实际容器与测试 PostgreSQL 的运行，不证明 Compose、公网 TLS、云端部署、真实 AI 或跨物理设备。

## 真实 Amazon 本机串联与逻辑恢复

`scripts/saas/verify-live-workflow.mjs` 实际访问 Amazon B09B8V1LZ3（HTTP 200），未替换 HTML、修改 DOM 或拦截为 fixture。网页注册 → 真实 MV3 同意采集及账号授权 → 插件 HTTP 上传 → 实际 PostgreSQL 受限角色商品库 → 独立 Node worker 运行 Mock 分析并保存 → 停止/重启实际 standalone Web 进程 → 另一隔离浏览器登录并查看保存结果 → 其他账号详情返回 404，全链通过。采到 9 张图、6 条卖点、0 视频，价格未采到，不假设字段齐全。两个合成测试账号已清理。

该验证的原始 HTML/profile/报告留在忽略的 `.test-data/saas/live-workflow/1792213504499/`，HTML SHA256 为 `59bcffa9852c018021ad9ccc4d12e31de4f0e9812648269901649d80be60e827`。可审阅的 [已保存 Mock 分析截图](screenshots/saas/live-amazon-saved-mock.png) 只有公开商品与合成账户；没有密码、授权码或 Token。仍是本机 HTTP、Mock AI、同一物理电脑，不是公网 SaaS/真实 AI/跨设备验收。

`scripts/saas/verify-logical-recovery.mjs` 在临时 PostgreSQL 18.4 集群内自行创建两个唯一测试库，种两个用户的合成 SQL 数据，以 `pg_dump 18.6 --format=custom` 备份，再 `pg_restore 18.6 --exit-on-error` 到自身创建的空目标库。12 张表记录数量及 checksum 一致，6 张业务表 FORCE RLS 定义一致；恢复后的 NOSUPERUSER/NOBYPASSRLS 应用角色无 scope 读 0 条、跨用户读 0 条、跨用户写入以 42501 拒绝。写入探针回滚后再次确认 checksum 未变。27,889 字节 dump 只含合成数据，源/目标临时库均已删除且残留复查为 0。

报告为 `.test-data/saas/logical-recovery/531dd8d17ea94a7face0aeaf68e80753/report.json`，dump SHA256 为 `d28521b0b2271c65f0ed15a5f63fc91270a73334503cd02d646cfc981726a5cf`。这里证明 SQL/策略恢复，不代表恢复后真实用户登录、有效 AI 结果质量、云端/PITR 或生产 RPO/RTO。Windows 客户端来自 [PostgreSQL 官方 Windows 页](https://www.postgresql.org/download/windows/)指向的 [EDB 便携包](https://www.enterprisedb.com/download-postgresql-binaries)，仅解压到 TEMP，未安装服务。Linux 恢复于上述 `6436dd9` CI 实际通过，使用官方 PGDG 的 17.11 客户端，没有降级服务器或跳过检查。

## PR 认证与订阅流程复核

用户要求先审阅 PR、暂不部署。本轮只修改开发分支及测试数据库。完整发现与范围见 [PR 审阅记录](saas-pr-review.md)。新增两项真实 PostgreSQL 并发回归证明：旧密码登录、旧授权码配对可以逃逸改密撤销，旧码均返回可用凭证 200；统一用户锁内重新验证/签发后均拒绝 401。另有 3 项跨标签页旧会话回归在旧码失败，登录/注册成功后再次失效广播的修复已通过。

- 旧实现按小时生成 Checkout 幂等键。新增的三个回归在旧代码全部失败：跨小时重复新建、同小时过期后复用旧页、provider 已接收但响应丢失后跨小时重复新建。现改为先持久化 UUID 和完整请求再调用 provider；三项均通过。
- 新增并发结算、配置变化后原参数恢复、超过安全窗口停止重发、完成并取消后的重新订阅、Webhook 延迟防重复、past_due/unpaid/incomplete/paused、客户/owner/价格/quantity/有效期及分页失败的回归。
- 新增网页主动核对接口，真实 route 验证匿名、跨站和扩展请求被拒绝，客户端伪造用户/套餐不影响其他用户。旧订阅终止事件不再覆盖新权益，重复事件不依赖再次访问 provider。
- 新字段通过迁移角色连续执行两次迁移均成功；真实 PostgreSQL 受限角色共 44 项通过。首次并行支付测试因两个文件复用同一合成 customer ID 触发唯一约束，改为每文件独立 ID 后通过。

这些测试使用真实 SQL、应用角色和路由；支付 provider 为离线模拟，没有发送 Stripe HTTP，没有测试付款、沙盒交易或真实交易。

## 失败记录与修复

- 迁移前旧基线 744/745，portable guide 拒绝版本点号文件名；最小修复后完整回归通过。
- 独立审查确认：改密未作废 pending code、导入商品自定义 ID 的 capture 重放、已认证请求等待期间发生撤销。均已修复并加入实际 route 回归。
- Stripe 读取最新状态移入用户锁，避免并行事件覆盖；媒体代理增加速率和进程并发限制。
- 首次启动 PGlite 缺父目录导致 readiness 503；数据库初始化现递归创建显式开发目录，嵌套空目录 SQL 回归通过。
- MV3 E2E 首轮因两个 Mock 标签触发严格选择器失败；修正选择器后通过，未把失败写成业务成功。
- 首次迁移脚本 top-level await/CJS、CLI 预览漏 options、测试重复 import 的 typecheck 失败均已修复并复跑相应命令。
- 独立队列任务在写结果前不提前暴露 succeeded，避免轮询误判；最终 UI E2E 已在队列路径通过。
- 新增逻辑恢复的首轮 [Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39005331463) 在该步骤失败：runner 默认 pg_dump 16.15 不能备份服务 PostgreSQL 17.11。此前静态、全量单测、受限角色 PostgreSQL 检查均通过；客户端修正后须重新执行完整 CI，不将 Windows 18.x 成功替代 Linux 17 验证。

## SaaS 打包与恢复后业务增强

本轮新增独立 `package:saas:extension`。真实 development（loopback）与 production 配置（保留的 `.invalid` 测试 origin）preview ZIP 均通过 CRC、逐文件 checksum 和 Windows 独立解包；每包 243 文件。所有产物在 `artifacts/saas/` 唯一目录，构建来源记录 `d56d14c` / dirty=true，不能当正式发布包。旧 extension/Windows ZIP 的 SHA256 保持不变。默认 SaaS 下旧打包入口在任何构建/删除前拒绝；新入口严格验证环境、origin、metadata、manifest 能力/CSP和服务端秘密。详见 [SaaS 商店准备](saas-store/README.md)，该文案仍是待填运营资料的草案。

增强逻辑恢复已在同一本机临时 PG18.4 + 客户端18.6 通过：源库由真实应用路由生成合法注册密码、商品、模板、竞品、内容、Mock 分析与任务；custom dump 恢复后先核对 12 表 SQL/checksum/RLS，再调用进程内实际 Next 路由，验证两账号正确密码登录、错误密码拒绝、商品/历史/合法导出业务 checksum 一致及跨用户 404。登录预期新增 2 条会话、更新限流；原会话及其他表不变。该过程是 Request/Response + 真实 PG，不是网络 HTTP、公网、真实 AI 或物理设备。报告 `.test-data/saas/logical-recovery/ddc59902c3f74ace85b41c2e23f3b8e4/report.json`，dump 37,368 字节、SHA256 `1a843b55012ee6b062ef2ad2637067a7a33f6d5fc3ff746b3a51484c30600ecb`；自建两库已删除并复查无残留。

`scripts/saas/verify-compose.mjs` 的 10 项边界测试通过；实际 Compose 编排已在提交 `881c3ec` 的 [完整 Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39015571302) 通过；它是临时 CI 验证，不是已部署。它只在临时 Linux CI 验证原服务网络、db DNS、受限角色、独立 worker 和命名卷重建，采用本次合成环境，不读取生产 `.env.production`。同一次 CI 的增强业务恢复、两种配置 preview ZIP、Docker 和 MV3 E2E 全部通过：Linux 单测 872 PASS / 14 SKIP（含 10 项 Windows 专属）、实际 PG 44/44、浏览器 2/2。Compose 成功核对内部数据库、原持续 Worker、Web/数据库容器重建后的原卷和业务 checksum、双用户 404；结束清理 3 容器、1 网络、1 卷及私有测试环境文件。

## 尚未证明的要求

| 项目                             | 状态 / 需要的证据                                                           |
| -------------------------------- | --------------------------------------------------------------------------- |
| HTTPS 云部署、正式 origin 扩展包 | 用户已指示暂不部署；实际 Docker/原 Compose 已通过临时 CI；公网 TLS 未验     |
| 完整真实链路                     | 未完成：实际 Amazon→MV3→本机 PG→Mock→重启/另会话已通过；云端与真 AI 未验    |
| 真实 AI                          | 未调用；需服务端凭据与明确测试预算/授权，另做内容质量核验                   |
| 跨物理设备                       | 未完成；同机独立浏览器只证明会话与服务端持久化                              |
| Stripe 沙盒                      | 未交易；需真实 test account、price、secret、Webhook 投递与取消/失败场景     |
| 真实交易                         | 未授权、未执行                                                              |
| 真实私人数据迁移                 | 源目录未改动；应先指定真实 SaaS 归属账号，再预览/提交，不导入测试账号       |
| 生产恢复/PITR                    | 本机物理/逻辑与合成账号恢复后业务通过；云端/PITR/生产 RPO/RTO 待验收        |
| 公开运营资料                     | 需经营者/隐私联系人/保留期限、邮件核验/找回、账户注销；商店材料旧版已标历史 |
| 远端 CI                          | 881c3ec 的打包/恢复/Compose 完整 CI 通过；后续看 PR 当前 checks             |

未购买资源、未公开插件、未部署/修改生产、未合并主分支、未改动旧 Release。外部验收缺口仍在原始目标内，不能将本轮实现定义为全目标完成。
