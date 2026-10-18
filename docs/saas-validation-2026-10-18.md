# 2026-10-18 SaaS 接续审计与验证

本轮接续 `codex/saas-migration` / `8d7709b`，稳定基线 `b83027a` 和 `codex/baseline-v1-before-saas` 保持。已有迁移、业务 UI、MV3 采集器和 Windows legacy 源码继续复用，未从零重写。**完整 SaaS 真实环境验收仍未完成。**

## 实际修复

- 扩展成功 ACK 后不持久保存完整服务器商品和分析历史；所属账号下一次队列写入时原子清理旧成功副本。pending、未归属资料及其他账户不自动清理，旧 ACK 不删除新版采集。8 项字节配额/并发/写入失败回归使用 storage mock，不冒称原生 Chrome 配额测试。
- 已接受 AI 任务的 GET 轮询遇到 429 时遵守秒数或 HTTP 日期 `Retry-After`，有限指数退避、5 分钟总期限；切换账号或取消立即停止等待/在途 GET。AI POST、任务中的 AI 失败响应不会被自动重发。9 项回归。
- 生产连接在处理业务前拒绝 SUPERUSER、BYPASSRLS 及特权成员，同时检查 current_user 与 session_user，防止特权登录先 SET ROLE 掩盖权限；生产 PGlite 开关不能绕过要求。`db:migrate` 改用独立管理连接、事务级迁移锁与原子事务，不向应用池注册管理员。10 项单元回归；新增保护在旧实现上的首批 6 项全部失败，修复后通过。
- Windows legacy 权限测试按原始 DACL 自动继承标记选择恢复方法，保留精确 SDDL 等值、实际拒写和数据完整性检查；不修改 launcher 或系统设置。旧测试夹具误差已修复，6/6 通过。
- RC 自有 HTTP Stub 明确关闭每次独立连接，保留 200/重放/429/计费/原资料保护断言。真实 Provider 无改动。此夹具不验证连接池复用；独立纯 Node 同样复现本机第二次 keepalive 响应阻塞。
- 新增显式 `build:webpack` 作为同一 Next.js 应用的可复验构建入口；默认 Turbopack 保留。`.gitattributes` 固定跨平台文本行尾，Windows 脚本保留 CRLF；已有文件仅归一化工作区行尾，没有提交几百个无关格式差异。
- 新增隔离 Windows PostgreSQL 验证器及 5 项清理护栏测试，失败会停自己的集群并保留报告；不安装系统服务、不连接已有数据库、不使用 trust。

## 本机实际结果

| 检查                            | 结果                               | 证明范围                                                                                                             |
| ------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 锁文件安装                      | PASS                               | 官方 pnpm 10.32.1 SHA512 与 registry 一致，`--frozen-lockfile` 成功；系统 fallback pnpm 11 的失败/自动配置修改已撤销 |
| TypeScript / ESLint / Prettier  | PASS                               | 全仓检查；初次格式失败来自 Windows CRLF 工作区，添加行尾约束后通过                                                   |
| 全量单元/集成                   | 944 PASS / 4 SKIP，93 文件，948 项 | PGlite、Mock、离线 Stripe 合同及既有业务；四项网络 PG 专属测试未执行，不能算通过                                     |
| `pnpm build`                    | 未完成，人工终止停滞               | MV3 成功；Turbopack compile 持续停滞，PostCSS 独立和原样生成的 worker 探针正常，未确定 native 调度根因               |
| `pnpm build:webpack`            | PASS                               | MV3 + Next.js standalone 生产产物，24 个静态页面及全部业务 API 路由                                                  |
| SaaS E2E                        | 0 PASS / 2 FAIL                    | 扩展 `launchPersistentContext: spawn UNKNOWN`；工作台 `goto /register` 90 秒超时，尚未进入注册操作                   |
| 真实 PG / 逻辑恢复 / standalone | 本机受阻，未通过                   | PG17.11 ready 后 Node 与原生 psql 认证超时；两版 Node、三种 loopback 地址多轮 TCP 复现，详见独立报告                 |
| 真实 AI、Stripe 沙盒、真实交易  | 未执行                             | 没有调用收费服务或支付 API                                                                                           |

初轮全量为 933 PASS / 4 SKIP / 4 FAIL：三个 RC HTTP Stub 超时和一个 ACL 夹具恢复失败；保留失败诊断后修复夹具，未跳过用例、放宽超时或更改真实 Provider。后续新增 5 个清理护栏、第二种 ACL 夹具及一项实际 PGlite 角色语义回归，最终 944/948。此前 2026-10-17 的 DPAPI 失败不套用到本轮；本轮这些用例实际通过。

本机工具与报告保留在忽略的 `.test-data`、`test-results/saas`、`playwright-report/saas`，不提交密码、浏览器 profile、数据库或真实商品私有资料。[本轮 PG 诊断、清理和复跑命令](saas-windows-postgres-2026-10-18.md)。

Chrome 测试包为锁定 Playwright 下载的 Chrome for Testing 156.0.8078.4；有效 PE x64、无 Zone.Identifier，两版 Node 与短临时 profile 均在启动时失败，未进入扩展业务。Windows SideBySide Event 33 记录激活上下文无法解析 156.0.8078.4 程序集；对应 manifest/DLL 存在且版本一致，根因仍未确定。另一次 .NET Hidden 启动诊断被自动审批以 `blocked by policy` 拒绝，未执行、未绕过，也未更改安全策略或用户浏览器。

## 历史任务完整访问补齐

终审发现原 `GET /api/jobs` 仅返回最新 200 条，旧任务虽保存在数据库却没有普通用户入口。现复用任务页补齐游标分页，默认 API 返回规模保持兼容、网页每页 50 条；支持前后翻页和当前页刷新。游标绑定已认证用户、严格验证结构/页大小，使用 `created_at + id` 稳定排序，并保留 PostgreSQL 微秒时间；对应索引幂等迁移。请求序号与 AbortController 防止旧页面响应覆盖当前页面。

新增 23 项实际 SQL/路由与 4 项 React UI 回归，使用 241 条合成任务、215 条相同时间及同毫秒不同微秒边界，覆盖超过 200 条历史、遍历不漏不重、双用户/游标隔离、非法输入、分页期间新任务和异步旧响应。本机全量现为 **971 PASS / 4 SKIP，95 文件、975 项**，静态检查及 Webpack 构建通过。新增分页路由测试也接入 `test:postgres`，需新提交 Linux 实际结果证明网络 PG 覆盖，不能以 PGlite 代替。

另新增一项浏览器任务分页/375px 用例：真实注册、退出、登录，只有任务列表 GET 使用 57 条明确标注的合成响应，实际点击下一页/刷新/上一页并核对请求游标和布局，不写入任务或触发 AI。这项只证明界面，不替代 SQL/隔离测试；本机未再次启动已知受阻的 Chrome，执行结果以新提交 Linux CI 为准。

## CI、部署与验收边界

提交 `3b3f697` 的 [Linux CI run 39114813829](https://github.com/LogiX-D/ProductSpy/actions/runs/39114813829) 已实际全部 success。日志核对：933 PASS / 15 SKIP（948 项，含 11 项 Windows 专属跳过），受限 TCP PostgreSQL 44/44，PG/pg_dump/pg_restore 17.11 增强恢复、完整生产构建、两种 preview ZIP、实际 standalone、Docker Web/Worker、原 Compose、MV3/SaaS E2E 2/2 全部通过。实际 checkout 的 PR merge `4aa5d53` 与分支 head 的 tree 相同，均为 `2cde1e608e2b4c6477071062a844f870f47c9972`；不是将旧绿灯套给当前代码。

生产应用以受限角色在真实 PG 中实际启动；管理员/成员拒绝的新增 10 项包括连接 mock 与实际 PGlite 角色 SQL 语义，不能将其扩大为本机 TCP 管理员拒绝验收。本机网络/浏览器失败保持原记录；Linux 通过不表示已经修复当前 Windows 环境。MV3 E2E 仍为 fixture Amazon、Mock AI 和同一 CI 主机上的独立浏览器。

本机基于干净 `3b3f697` 另外生成两个 243 文件的独立 preview ZIP，并用 PowerShell 独立解压逐文件核对 SHA256。development（loopback）ZIP 指纹 `01bf4cc1cd7ea58ea0eb7073edfaa0d50db9d224d47cd962c7906e1b09406428`；production 配置使用保留 `.invalid` 地址，ZIP 指纹 `c81a2660632fdbf45d61b351c97a685c714831cc084aac016eff4ac51416e884`。receipt 中 source revision 为 `3b3f697`、dirty=false；均未发布，也不是可连接正式服务的发行包。首次 production 包因子进程 Git 所有权校验取不到 source commit 而拒绝，设置仅当前进程的精确 safe.directory 后重新构建通过，未修改全局 Git 配置。

已查询远端 `8d7709b` 的 [Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39024144768)，其结论为 success；这是原提交证据。当前修改的结果以 [PR #1 的对应提交 checks](https://github.com/LogiX-D/ProductSpy/pull/1/checks) 为准，不将旧成功套给新代码。CI 仅构建和临时合成数据验证，不部署公网、购买资源、发布插件或合并主分支。

开发运行 `pnpm dev`，默认磁盘 PGlite；正式运行采用 PostgreSQL 17+、受限角色、单独迁移、Web/Worker 容器与 HTTPS 边缘代理，具体 [环境和部署方案](saas-deployment.md) 已保留。真实服务器/TLS、正式扩展 origin、Amazon→云端→真实 AI→跨物理设备、Stripe 沙盒与真实交易、生产备份/PITR、邮件找回/核验和运营资料均未由本轮本机结果证明。未迁移私人数据，未变更生产或公开发布。
