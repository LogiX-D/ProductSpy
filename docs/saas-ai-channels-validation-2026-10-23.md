# AI 多渠道验证：2026-10-23

用户选择“主流服务商都需要”“管理员统一配置，用户选择渠道和模型”，并授权 Codex 设置渠道管理员。复用现有 Next/React、AI schema、持久任务与额度，不增加客户端密钥。配置说明见 [渠道管理](ai-channels.md)，官方接口参考见 [服务商来源](ai-provider-sources.md)。

已实现 14 类服务商预设、Anthropic Messages 原生适配及 OpenAI 兼容适配、管理员页面、服务器 UUID 权限、AES-256-GCM 配置密文与并发版本检查。普通用户在商品分析、竞品分析、内容生成中选择白名单渠道/模型；结果与用量保留渠道/模型，既有记录继续可读。队列锁定配置，执行前拒绝失效配置，不自动切换渠道或重新调用；个人业务导出不包含平台密钥或任务内部配置。

本机运行记录：

- 全量单元/集成：109 文件，1161 PASS / 5 SKIP（其中 PostgreSQL 专用测试需另跑），包含渠道管理、传输、权限、队列、历史及备份。
- Next 16.4.1 升级后全量单元/集成仍为 1161 PASS / 5 SKIP；typecheck、lint 与扩展/Web 默认生产构建通过。
- 全仓 format:check 仅因原有未提交的验收矩阵格式改动失败，保留该改动。另检查本轮所有其他文件与矩阵的已提交基线，不将用户格式差异提交或覆盖。
- 本机临时 PostgreSQL 17.11：六组受限角色测试 110/110，包含渠道配置 FORCE RLS、未设置内部作用域不可读写、服务器权限恢复及扩展连接；独立角色迁移/重复迁移、生产高权限/可切换成员拒绝、逻辑备份和恢复均通过。自建集群已停止并清理，报告位于忽略目录 `.test-data/saas/windows-postgres/00f8ee88-314d-40a9-bd62-8b966c5103ce/report.json`。
- 实际浏览器多渠道流程通过：管理员保存两个本地 HTTP stub 渠道，用户选择第二个渠道及模型，后台只向选定地址发送一次请求，结果保存并刷新可读；普通用户管理页拒绝访问，目录不暴露密钥或端点。stub 响应不代表真实 AI 或付费调用。
- 本机 SaaS 浏览器共 3 PASS / 2 FAIL；失败均为 Windows 上加载实际 MV3 的 Chromium `launchPersistentContext: spawn UNKNOWN`，测试尚未执行业务步骤，保留失败。Linux MV3 复跑结果待追加。

发现并修复：全量旧业务回归最初 30 项失败，原因为把完整 AI 请求交给严格渠道选择 schema；现只提取 `channelId`/`model`，相关回归及上述全量重新通过。初次类型与 lint 问题也已修复，未跳过失败用例。

初次 Next 16.4.0 生产构建在完成编译后因已知安全提示退出 1。已按官方公告最小升级至 16.4.1，同步对应 SWC/env，保留原已修复的 sharp 0.35.5；生产构建通过，升级后实际浏览器三项 Web 流程 3/3 复跑通过。[官方 SVG 优化公告](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)、[官方 Cache Components 公告](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr)。

专用管理员账号已通过测试站 HTTPS 注册，登录凭据与渠道加密主密钥保存在仓库外的当前 Windows 用户私有文件，未输出至聊天或 Git；管理员 UUID 待部署时绑定。

独立只读审查覆盖管理员鉴权、脱敏、RLS 事务作用域、模型白名单和任务幂等快照，未发现需要阻断的可证实问题；该审查不替代真实 PostgreSQL 与浏览器运行。功能提交 `37aca85` 的完整 Linux CI 已手工触发，等待实际结果；无自动部署至生产。

首轮最终文档提交 `90417c3` 的 [Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39833025253) 在 Compose 校验失败：旧断言要求整个 schema 恰好六张 FORCE RLS 表，而本次合法新增了第七张平台配置表。此前静态/完整单元（1150 PASS / 16 SKIP）、受限 PG（110/110）、恢复、默认构建、standalone 及实际 Web/Worker 容器检查均通过；后续浏览器与镜像导出未执行。现改为逐名验证六张租户表，并单独验证平台配置表、唯一内部作用域读写策略，以及回滚事务中的非空 canary 对无标记/用户上下文不可见、未授权写入被 RLS 拒绝，保留首轮失败记录。等待修复后的完整 CI，不将失败流水线记为通过。

尚未完成：本轮完整 CI、测试站升级、管理员权限绑定以及各服务商真实凭据调用。用户原先要求稍后配置真实 AI，当前仍保持 Mock、支付关闭；不将 HTTP stub、Mock、密文配置保存记为真实 AI 验收，不进行真实交易或公开发布。
