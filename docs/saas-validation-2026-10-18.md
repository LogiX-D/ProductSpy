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

## CI、部署与验收边界

已查询远端 `8d7709b` 的 [Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39024144768)，其结论为 success；这是原提交证据。当前修改的结果以 [PR #1 的对应提交 checks](https://github.com/LogiX-D/ProductSpy/pull/1/checks) 为准，不将旧成功套给新代码。CI 仅构建和临时合成数据验证，不部署公网、购买资源、发布插件或合并主分支。

开发运行 `pnpm dev`，默认磁盘 PGlite；正式运行采用 PostgreSQL 17+、受限角色、单独迁移、Web/Worker 容器与 HTTPS 边缘代理，具体 [环境和部署方案](saas-deployment.md) 已保留。真实服务器/TLS、正式扩展 origin、Amazon→云端→真实 AI→跨物理设备、Stripe 沙盒与真实交易、生产备份/PITR、邮件找回/核验和运营资料均未由本轮本机结果证明。未迁移私人数据，未变更生产或公开发布。
