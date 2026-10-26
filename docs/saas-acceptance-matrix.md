# SaaS 要求与验收证据矩阵

2026-10-23 多渠道更新后的当前状态：获授权测试 Web/Worker 源码为 `5de92cb`，运行已认证 CI checkout `849d4d8a9135c8c699a1af96463a3520adc704f3`，数据库现为 13 表（新增平台加密渠道配置）。[完整应用 CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39897999086) success：Linux 1161 PASS/16 SKIP、受限 PG 110/110、浏览器 5/5；交付记录提交 `9909351` 的 [完整 CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39900193728) 同样通过，应用代码与部署版本一致。已备份/排空并使用独立角色原子迁移，原数据库容器未重建，既有六表 count/checksum 保留。专用管理员公网 47 项、API 边界 6 项、新云端 Worker Mock/API 9 项通过。随后实际云端 13 表一致快照经 age 加密、异地密文校验并恢复至隔离库，13 表 count/checksum 与 7 张 FORCE RLS 均匹配；当前应用镜像以受限角色成功解密恢复的渠道配置，临时库已清理。真实服务商调用、Stripe 沙盒和发布前条件仍待验；保留全局 Mock、关闭支付。详见 [多渠道验证记录](saas-ai-channels-validation-2026-10-23.md)。以下按日期保留的旧版本部署段落描述当时状态。

2026-10-23（Asia/Shanghai），用户在收到人工验收清单后回复“已完成验收”。新版扩展、无码自动连接、真实 Amazon 采集、云同步、Mock 分析/内容保存与跨物理设备查看的主清单据此记录为用户报告完成；未提供逐项日志或设备信息，不作为 Codex 本轮复跑。多用户与断网补充检查未收到单独结果。真实 AI、Stripe 沙盒及发布前事项仍未完成。详见 [人工验收记录](saas-validation-2026-10-23.md)。以下历史 CI 和失败记录保留原范围。

2026-10-22（本地时间）重新核对原始目标、当前源码、已完成运行与测试主机；完整目标仍未完成。正式架构保持 **Chrome MV3 + 在线 SaaS + 云端后端**，不以 fixture、Mock 或同机浏览器缩小验收范围。

2026-10-20 的历史实现证据为扩展提交 `05cf4d3` 的 [完整 CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39309068615)：success，Linux 1004 PASS/15 SKIP、受限 PG 67/67、浏览器 3/3，及恢复、默认构建、ZIP、standalone、Docker、原 Compose；实际 CI checkout 的 tree 与该提交一致。`1db583e` 只更新记录，没有修改已验证的应用源码。当时测试站后端为 `c481268` / 镜像 checkout `72ac8db7`，不是将全部后续提交都称为已部署。

当前扩展源码 `dfb5c43` 的 [完整 CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39634596583) 实际 success：Linux 1056 PASS/15 SKIP、受限 PG 98/98、浏览器 4/4，及全部静态、恢复、构建、ZIP、standalone、容器和原 Compose。自动连接更新时，获授权 HTTPS 测试站 Web/Worker 使用后端 `e8fafa0`，镜像 checkout `11dbae2e8f20e0780128c5de64cbf565ecbedc97`。更新前先加密备份、排空任务，数据库未迁移/重建，六表 count/checksum 保留；云端真实 MV3 fixture 自动连接 12 项已通过。最终干净来源 ZIP 为 dfb5c43/243 文件，SHA256 `169e70a4fb119ad0fdaa2dfcfa2956cdaf79e1a8cff1299c716b06e79334f36e`。详见 [自动连接与更新记录](saas-validation-2026-10-21.md)。

后续登录限流修复 `e545783` 的 [完整 CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39637407458) 已 success：Linux 1057 PASS/15 SKIP、受限 PG 99/99、浏览器 4/4 与所有构建/恢复/容器/Compose。当次获授权测试 Web/Worker 为该源码，镜像 checkout `8718b91cb61d2c7af523cc995c59c5739ad9af59`；加密产物来源和加载镜像身份已核验，备份/排空后更新，数据库未重建或迁移，六表 count/checksum 保留。当时扩展与 shared 源码和已交付 dfb5c43 包一致。详见 [10-22 运行及云端复验](saas-validation-2026-10-22.md)。

此前 2026-10-17/18 的本机及 Linux 证据见 [原验证记录](saas-validation.md)、[10-18 记录](saas-validation-2026-10-18.md)；云端部署与恢复见 [10-19 记录](saas-validation-2026-10-19.md)，最新凭证/隐私/CI/云端结果见 [10-20 记录](saas-validation-2026-10-20.md)。下表按原要求逐项保留验证边界。

| 原要求                                   | 当前实现与已核对证据                                                                                                                                                                                                    | 尚缺的证据或工作                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 先审计、复用代码、保留稳定回退基线       | [架构审计](saas-audit.md)；Next/React/TS/Zod、Amazon 采集器及既有业务复用；Windows/JSON 审计后保留为显式 legacy；远端 main 与 baseline 为 `b83027a`                                                                     | 依用户要求不合并主分支、不删除历史源码/发行包/资料                                                              |
| 独立分支、更新要求/AGENTS/计划           | `codex/saas-migration`、Draft PR #1；根/网页 AGENTS、[要求](saas-requirements.md)和[计划](saas-plan.md)切为 SaaS                                                                                                        | 最终验收仍未完成，PR 保持 Draft                                                                                 |
| MV3 与现有 Amazon 采集                   | 保留 DOM/JSON-LD 采集器；历史实页采集有独立本机记录；当前云端实际 MV3/fixture 采集通过                                                                                                                                  | 真实 Amazon 云端 CI 保留验证码失败；2026-10-23 人工主清单由用户报告完成，非 Codex 复跑                          |
| 账号、安全云 API、不含服务器密钥         | 同浏览器网页账号自动连接，无需 ID/配对码；可信 Origin + 有效 web Cookie；业务受限 bearer；凭证仅 trusted session；实际 HTTPS 自动连接及内存断言通过                                                                     | 完整本机敏感数据静态保护和历史磁盘残留安全擦除未证明；不把访问限制当成加密                                      |
| 提交、幂等、失败重试与网络恢复           | 用户 outbox、captureId、条件 ACK、有限退避/429 冷却；成功后清理上传副本；云端实际断网恢复通过；实际浏览器进程重启、自动连接或正常网页登录、原幂等键单次恢复上传通过                                                     | 长期生命周期/浏览器存储压力与真人体验未做规模或耐久认证；pending/unassigned 不自动丢弃                          |
| Chrome 权限、隐私及远程代码政策          | 四项权限和精确 HTTPS origin；采集同意；包内执行代码/self CSP；Limited Use 声明和桌面/移动隐私入口已部署核对；[披露草案](saas-store/privacy-disclosures.md)                                                              | 经营者、联系人、供应商/地域、保留/注销流程、完整基础设施保护和商店审核仍未完成；未提交或发布插件                |
| 注册登录、账号与个人设置                 | scrypt、数据库会话、改名/改密/退出及撤销、Cookie 安全属性；PG 与浏览器回归；云端独立账号 HTTPS 登录已实测                                                                                                               | 邮件核验/找回、完整账号注销仍是公开运营前继续项；未伪报已经提供                                                 |
| 首页、商品库/详情、搜索筛选、统一响应 UI | 复用业务组件；SaaS E2E 覆盖商品/UI 与 375px；短桌面和移动隐私入口通过；云端库展示、编辑和隔离已核验                                                                                                                     | 含跨物理设备查看的人工主清单已由用户报告完成；未提供设备与逐项运行资料                                          |
| 商品分析及分析记录                       | 原 pipeline/schema/历史复用，独立 Worker 保存结果；云端商品分析/历史/用量/重启与恢复实际通过                                                                                                                            | 当前为 Mock；真实提供商输出质量、费用、时延与异常未验                                                           |
| AI 多渠道与管理员统一配置                | 14 类预设（含自定义）；服务器 UUID 管理员、密钥加密且不回显、用户白名单模型选择、任务配置快照；公网 47 项通过                                                                                                           | 真实密钥、模型可用性/质量/费用与预算未验；全局 Mock 继续优先                                                    |
| 内容创作与历史任务                       | 原内容/模板/竞品业务复用；云端内容 16 项含九类输出、版本/手改/冲突/隔离；任务稳定游标分页保留微秒并覆盖旧响应竞态                                                                                                       | 真实 AI 创作及质量未验；不能以任务历史分页测试代替真实内容质量                                                  |
| Free/Pro 权限和用量                      | 服务端 50/5000 商品及 UTC 月 10/500 AI；预留、失败/中断计数、requestId 去重及导入/降级限制；云端 Free/合成 Pro/恢复 Free 已测                                                                                           | 合成 Pro 不是付费订阅；真实付款获得权益仍待支付验收                                                             |
| 订阅、账单与 Webhook                     | Checkout/Portal/reconcile/Webhook 代码及合同测试；结算尝试持久化、幂等、防重复订阅、原始正文签名及事件去重                                                                                                              | Stripe 真实测试账户、price、test key、Webhook 投递/付款/取消/失败尚未配置；真实交易未授权且未执行；支付继续关闭 |
| REST、认证、资源授权与严格隔离           | SaaS 路由使用服务端身份/tenant；显式 user_id + 六表 FORCE RLS；应用启动拒绝特权角色及其成员身份；受限 PG 110/110、独立平台配置 RLS 与云端跨用户 404                                                                     | 测试环境证据不替代未来生产角色/权限变更后的重新核验                                                             |
| PostgreSQL 数据模型及持久化              | 13 表涵盖 users/sessions、采集、jobs、订阅、用量、必要审计及平台加密渠道配置；商品/分析/创作复用用户作用域 JSONB；独立迁移连接/原子事务；云端原卷/重启/恢复 checksum 一致                                               | 真实私人旧资料未指定归属，未导入测试账号；负载/索引或拆表应依据实际负载，不声称规模认证                         |
| AI 任务状态、额度预留、失败及恢复        | SQL 入队/任务/额度原子提交，独立 Node/容器 Worker；保存成功后暴露完成；中断不自动重发可能收费 POST；GET 有限退避                                                                                                        | 当前提供商为 Mock；真实服务商费用不确定、网络异常与任务执行验收仍待真实配置及预算                               |
| API 限流、日志与异常处理                 | 持久限流、统一错误、敏感日志抑制、操作审计；路由/429/恢复测试；云端任务可见失败与安全诊断                                                                                                                               | 集中日志、告警投递、过期记录维护和生产保留策略未运行；当前日志不能当完整运营监控                                |
| 旧数据迁移与备份恢复                     | 原子业务备份、CLI preview/commit、源 checksum 不变；旧版云端恢复 12 表/RLS 及实际路由 6 项分析 + 10 项内容；新版 13 表一致快照/异地密文/隔离恢复 checksum、7 表 FORCE RLS 与受限角色解密渠道配置通过；每日 age 加密备份 | 私人资料需真实归属账号；自动异地复制/保留清理、告警、PITR 和正式 RPO/RTO 仍需配置与演练                         |
| 开发、测试、生产配置及部署准备           | 开发 PGlite、测试受限 PG、生产 PG 模板；Docker Web/Worker + 原 Compose 实际 CI；获授权 Ubuntu 测试主机已部署；可信 IP HTTPS、续期与备份 timer 实测                                                                      | 正式域名、付费资源、生产服务未授权；不能将测试站称为生产上线或 SLA 认证                                         |
| 自动构建、测试与可回退交付               | 当前完整 CI success；干净 `dfb5c43` HTTPS 预览 ZIP（243 文件）校验通过；后端加密镜像来源核验后更新，旧镜像/配置/数据库保留；无主分支合并或公开发布步骤                                                                  | 人工基础链路已由用户确认；真实 AI、Stripe 沙盒及发布前事项仍缺，整体不能标 complete                             |
| 正式使用不依赖 Windows/本地程序          | 测试 Web/Worker/PostgreSQL 运行于云端 Ubuntu；Linux CI 的真实 MV3 直接连接公网 HTTPS，无 Windows 工作台/本地 Node 服务                                                                                                  | 含跨设备查看的人工清单已由用户报告完成；真实 AI、支付和生产正式使用仍未验收                                     |

## 完整业务链路的实际范围

已取得以下不同范围的证据，不能拼接为已完成的真实云端全链路：

1. 历史实页路径：实际 Amazon → 实际 MV3 → 本机 PostgreSQL → 保存 Mock 分析 → 另一隔离浏览器读取。见原始运行记录；不证明当前云端真实 Amazon 或真实 AI。
2. 2026-10-20 的云端 fixture 路径：[run 39309061740](https://github.com/LogiX-D/ProductSpy/actions/runs/39309061740) 的 fixture job 11 项通过：真实 MV3 + 明确 Amazon HTML fixture → 可信 HTTPS 云端 → 商品库 → 独立 Worker 保存 Mock → 同一 CI 主机另一会话读取 → 其他账号 404，以及实际断网恢复和内存凭证断言。live job 因实际页面验证码而失败，整体 run 为 failure。

3. 当前自动连接云端 fixture 路径：[job 119342841700](https://github.com/LogiX-D/ProductSpy/actions/runs/39634589746/job/119342841700) 12 项实际通过：网页登录后无需配对码连接实际 MV3 → fixture 提取 → 可信 HTTPS 上传 → 商品库 → 独立 Worker 保存 Mock → 独立会话读取 → 其他账号 404，以及 session 内存和实际断网恢复。先前连接失败发生于测试站切换窗口；更新完成后只重跑失败 fixture，保留原失败。独立 live job 仍 CAPTCHA 失败，因此整个 workflow 不是全绿。

当前完整 CI 还验证真实浏览器进程重启、保留网页登录时自动连接、Cookie 丢失后不复用旧身份、原账号队列及原幂等键恢复。它使用本机 HTTP/PGlite/fixture/Mock，证明同一真实 profile 的凭证/队列生命周期，不证明云端跨物理设备。

2026-10-19 19:21 UTC 再次只读检查测试主机：Web/Worker/PG 均 running，Web/PG healthy、OOM=false；应用 AI_MODE=mock，AI/Stripe 密钥不存在。公网 `/api/health`、`/api/status`、`/privacy` 均为 HTTP 200、TLS 1.3 校验成功，status.mode=mock，隐私页 Limited Use 可见。该探针未执行注册、AI、付款或删除任何数据，也不替代业务链路。

2026-10-23 用户已报告完成上述人工主清单，补入真实 Amazon、云端同步、Mock 保存与跨物理设备查看的用户确认；此前 CI 的验证码失败仍保留，不改写为自动测试成功。仍须配置并验证真实 AI 调用与结果，以及独立 Stripe 沙盒付款/Webhook/取消/失败。继续遵循用户既有安排保持 Mock、支付关闭；正式发布前安全/运营资料另按上表补齐。

人工主清单的用户确认已推进验收。最终验收仍依赖真实 AI、支付及其余发布前条件，阶段 10 保持未完成，禁止用用户完成反馈、当前预览、绿色 CI 或文档完整性宣称原目标全部达成。
