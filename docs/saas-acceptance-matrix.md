# SaaS 要求与验收证据矩阵

2026-10-18 接续结果见 [最新验证](saas-validation-2026-10-18.md)：最终业务提交 `abc58f8` 的本机静态/单元及 Webpack 构建通过；对应 Linux CI 全部通过（真实 PG 67/67、浏览器 3/3、恢复、默认构建与容器/Compose）。本机网络 PostgreSQL、浏览器回归受执行环境限制，未算通过；Linux 成功不表示该 Windows 限制已修复。下表历史成功仍仅对应其原提交与运行环境。

原目标保持为 Chrome MV3 + 在线 SaaS + 云端后端，最终验收未完成。矩阵依据当前代码和实际运行范围，不以 CI 绿灯推导尚未执行的外部验证。最终业务提交 `abc58f8` 的 [完整 CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39116442362) 成功，实际 merge tree 与该提交一致；后续只更新报告的提交不冒称同一运行已验证其他代码。

| 原要求                                            | 当前实现与权威证据                                                                                                                   | 仍缺的证据或工作                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 先审计、复用旧代码，保留稳定回退基线              | [架构审计](saas-audit.md)；原 Next/React/schema/采集器/Windows 兼容代码保留；main 与 baseline 分支保持 `b83027a`                     | 迁移 PR 未合并，按用户要求保留 Draft                                          |
| 独立分支，更新要求、AGENTS 和开发计划             | `codex/saas-migration`；根/网页 AGENTS、requirements/plan 已切为 SaaS；旧说明标历史                                                  | 打包预览通过；正式 origin、运营资料与商店审核仍待完成                         |
| MV3、现有 Amazon 商品采集                         | manifest MV3；真实 B09B8V1LZ3 HTTP 200，9 图/6 卖点，源码采集器复用                                                                  | 此页无视频且未采到价格；正式 Chrome 稳定版及更多实际页面覆盖未验              |
| 扩展账号、安全 API、无服务端密钥                  | 一次性来源绑定授权码、受限 bearer、trusted storage；真实 PG 认证回归、实际 MV3 账号授权/上传                                         | 正式 HTTPS origin、实际外部 TLS 和发布包仍未验                                |
| 失败重试、重复处理、断网恢复                      | owner 队列/captureId/条件 ACK/8 次退避/429 冷却；真实 MV3 fixture E2E 断网恢复                                                       | 长期 Chrome 生命周期/配额压力不属于当前测试已证明范围                         |
| Chrome 权限、隐私与远程代码政策                   | 精确 origin + activeTab/scripting/storage/alarms；采集同意；自包含脚本；[SaaS 披露草案](saas-store/privacy-disclosures.md)           | 经营者、联系人、供应商/地域、保留和删除流程、实际基础设施保护与商店审核未完成 |
| 注册登录、账号个人设置                            | scrypt/持久会话/改名/改密/退出及撤销；登录、配对与改密竞态已修复，实际 PG 回归 44/44                                                 | 邮件验证/找回/账号注销列为运营继续项，未伪报已经提供                          |
| 首页、商品库/详情、筛选搜索、统一响应式 UI        | 既有 UI/业务组件复用；SaaS UI E2E 及 375px 页面通过；真实 Amazon 上传在商品库展示                                                    | 正式公网访问、真实用户体验与其他设备视口未验                                  |
| 商品分析、记录、内容创作、历史任务                | 既有分析/对比/内容 pipeline、版本/历史；持久 jobs + 独立 Worker；浏览器保存 Mock/内容/任务流程通过                                   | 真实模型调用及内容质量、真实费用与时延未验                                    |
| Free/Pro 权限、用量、订阅账单                     | 服务端 50/5000 商品与月 10/500 AI、原子预留、失败计数、导入限制；Stripe Checkout/Portal/reconcile/Webhook 合同测试                   | 真实 Stripe 沙盒 Webhook 投递/付款/取消/失败与真实交易分别未验                |
| REST、认证、资源授权、用户数据严格隔离            | 原路由逐步接 SaaS tenant；PG 无 SUPERUSER/BYPASSRLS，显式 owner + 6 表 FORCE RLS；跨用户详情/历史/任务 404                           | 生产迁移角色/应用角色及外部环境需要再次核验                                   |
| 商品/采集/分析/创作/任务/订阅/用量/必要日志持久化 | PG 12 表，业务模型复用 JSONB；capture_events/jobs/subscriptions/usage/audit；真实 DB 重启、容器 Web 重建与 checksum 通过             | 生产负载、索引/文档拆表需求须据实际负载判断，未声称规模认证                   |
| AI 任务状态、失败和恢复                           | SQL 入队/预留、独立 Node/容器 Worker；已运行任务中断不自动收费重试；成功在结果保存后可见                                             | 云 Worker 运维、告警与真实服务商异常未验                                      |
| 限流、日志、异常处理                              | 持久限流、JSON 错误、敏感日志抑制、操作审计；路由授权与恢复回归                                                                      | 集中日志/告警、过期记录维护及生产保留策略未运行                               |
| 旧数据迁移、备份恢复                              | 原子业务备份/CLI dry-run+commit、源 checksum；物理/custom dump/RLS；Windows/Linux 恢复后实际路由登录/商品历史/合法导出 checksum 通过 | 私人旧数据未迁入测试账号；需实际归属账号；真实私人资料与云端恢复仍未验        |
| 开发、测试、生产环境配置                          | PGlite 开发、受限 PG 测试、生产 PG17+ 模板；Docker Web/Worker 和原 Compose 实际 CI 通过                                              | 真实 HTTPS、生产备份/PITR/RPO/RTO 和切换演练未验                              |
| 自动构建、测试及部署准备                          | 最终业务 `abc58f8` 完整静态/单元/PG/构建/standalone/Docker/MV3 CI；无部署、发布或主分支合并步骤                                      | 真实云端部署与外部服务仍待验收                                                |
| 不依赖 Windows 的正式使用                         | 线上代码路径默认 SaaS；Linux 实际 standalone 与 Docker Web/Worker 已运行；旧桌面仅显式 legacy                                        | 尚未指定可操作的预发布目标及访问范围，普通用户的真实公网使用仍未证明          |

## 最终真实业务链路

已验证：网页注册 → 实际 MV3 登录 → 实际 Amazon 采集 → 本机 PostgreSQL → 商品库 → 独立 Worker 保存 Mock 分析 → Web 重启 → 同一电脑的另一隔离浏览器登录查看 → 另一用户拒绝访问。详见 [验证记录](saas-validation.md)。

尚未验证：安装到正式 Chrome 稳定版并连接获授权的公网 HTTPS 服务 → 真实 AI → 从另一物理设备登录查看；真实 Stripe 沙盒与真实交易分别验收。Mock、fixture、私有 Host/Origin 模拟、单机浏览器和临时 CI 环境都不替代这些证据。

2026-10-18 的持续迁移指令允许自主实现、修复、验证与开发分支提交，生产变更和公开发布仍需单独授权。缺少获授权的目标环境、真实 AI 凭据与明确预算、物理设备及支付测试条件时，不擅自购买、公开发布、调用收费服务或迁移私人资料，也不将完整目标标为完成。
