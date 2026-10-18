# ProductSpy SaaS 迁移审计

审计日期：2026-10-17（Asia/Shanghai）。GitHub `LogiX-D/ProductSpy` 为现有公开仓库，远端 main 与本地审计基线均为 `b83027a`；审计时工作区干净、无开放 PR。已有 v1.0.0/rc.2 等 Release 为草稿，保持原样。

## 现状与复用决策

| 层      | 审计发现                                                                     | 决策                                                      |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| 扩展    | MV3、Vite、React、activeTab 用户触发注入，完整 Amazon DOM/JSON-LD 采集       | 保留采集器；替换 localhost 通信、账户隔离队列和授权       |
| 工作台  | Next.js 16 App Router、React 19、TypeScript、Zod、Tailwind、已有响应式 UI    | 保留；新增登录/账号/账单/任务/隐私页                      |
| 业务    | 商品、分组标签、批量/搜索筛选、图片与视频、AI 分析历史、竞品、模板、内容计划 | 保留 schema/合并/版本/快照/导入导出/AI Provider           |
| 认证    | 自动本机 cookie、进程内会话、唯一扩展配对凭证                                | 替换为数据库账户、密码哈希、持久会话、多扩展授权与撤销    |
| 持久化  | products/templates/comparisons/content-plans/analysis-usage 五类 JSON        | 按用户迁移到 PostgreSQL JSONB 文档，保留原 schema         |
| 并发    | 进程内队列和本机备份 journal                                                 | PostgreSQL advisory 用户写锁、事务、RLS；保留 legacy 分支 |
| Windows | 原生目录选择、explorer、DPAPI 启动器、portable ZIP                           | 云模式禁用服务器目录操作；浏览器下载复用；旧源码保留      |
| 部署    | standalone 输出；无 Docker、CI、数据库迁移或账户配置                         | 增加容器、环境模板、迁移/导入脚本、CI；本轮不部署生产     |

审计依赖安装快照为 Next 16.4.0、React 19.3.0、Vite 7.3.7；锁文件是构建依据，不能把源码范围 `^16.0.0` 当成实际安装版本。

## 原 API 范围

32 个路由文件：status、session；bridge code/pair/status/revoke；products 列表/详情/analysis-history；library 定义/batch/import/export；analyze-product、analysis-usage；comparisons 列表/详情/backup、analyze-comparison；templates 列表/详情/backup；content-plans 列表/详情/references/backup、generate-content；history/archive；workspace-backup；media/downloads。逐一审查了认证入口、仓储归属和桌面依赖。新增 SaaS API 在这些业务契约之外提供 auth、billing、jobs、health。

## 已识别的安全边界

- 商品 ID 原来为 `amazon:ASIN`，跨账户相同；必须带 user_id 数据库主键与服务器 scope。
- 固定 Dexie 库、任意错误回退缓存、sessionStorage 草稿和模块内草稿 Map 都可能泄露前一账号正文。SaaS 禁业务离线缓存并隔离草稿；旧模式独立保留。
- 扩展旧队列无 owner，不能静默归给新账号；旧上传 ACK 不能清除新版 pending；网络响应返回前后必须验证当前账号。
- 扩展权限只能提交商品及管理当前连接，不能读取全库/备份/分析/账单。
- 密码修改须撤销所有会话与未消费授权码；排队写操作取得租户锁后重新认证。
- 额度须在服务端控制，并覆盖采集、库导入和完整备份恢复，失败事务不得部分写入。
- Stripe 需原始正文签名、环境区分、事件去重、客户/订阅/价格绑定和串行读取最新状态。浏览器跳转不能授予 Pro。
- 素材代理保留 Amazon 白名单/大小限制，并增加账户/全局速率及进程并发限制。

## 迁移前基线验证

本轮实际执行旧单元测试：744/745 通过。失败为历史 portable guide 链接校验不接受 `v1.0.0-final-quality-validation.md` 中的点号。迁移分支作最小正则修复，原基线保持不变。历史人工 53/53 和旧截图仅代表原发行版本，不能替代 SaaS 验收。

## 目标架构决策

继续使用 Next Web + REST Route Handlers；生产 PostgreSQL，业务文档 JSONB + user_id 复合键。账户、会话、采集事件、使用额度、任务、订阅、Webhook 和审计使用关系表。选择 JSONB 可复用复杂分析/内容版本格式及现有验证；代价是每用户工作区文档整行读写，后续应在真实负载证据下拆分资源表。当前写操作按用户串行，GET 可独立读取，完整备份串行获取一致状态。

PGlite 只供无数据库的本机开发及确定性 SQL 测试；不作为生产、多实例或网络 PostgreSQL 的证明。AI 执行复用原业务 pipeline，通过 PostgreSQL 持久队列和独立 Node worker 调度；额度在入队时预留，requestId 重放不重复消费。中断可查看且不自动收费重试。邮件验证/找回、正式隐私联系人及生产运维仍需继续完成/验收。

参考：[Chrome MV3 要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)、[Chrome 商店政策](https://developer.chrome.com/docs/webstore/program-policies/policies)、[Stripe Webhook](https://docs.stripe.com/webhooks)。政策审查是代码依据，不代表商店或支付平台已批准。

## 2026-10-18 接续审计

本轮工作目录最初仍在 `codex/commercialization-system` / `b3d2f56`，fetch 后确认远端 main 为 `b83027a`，SaaS 开发分支已有 15 项提交至 `8d7709b`，Draft PR #1 未合并。工作区无原始未提交变更，接续同名开发分支；未从旧目录另起重复迁移，未改主分支或基线。

复审确认原先的本机匿名认证、单例 JSON、localhost 通信和共享 Dexie 等缺口已在 SaaS 分支解决。新增具体发现：成功同步商品完整副本无限增长会耗尽扩展存储；多个标签页 750ms 任务轮询可超出每用户 180/min 限流并错误终止等候；生产数据库的受限角色要求此前主要依赖运维配置，应用未强制拒绝绕过 RLS 的连接。这三项均有针对性修复和测试，实际运行记录持续补入验证文档。

本轮重新阅读 Chrome 官方 MV3 和用户数据政策，确认代码自包含、按用户触发采集、精确服务 origin、显式云端采集同意与凭证最小权限仍适用；正式隐私披露、基础设施保护和商店审查未因代码审计自动通过。[官方用户数据说明](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)。
