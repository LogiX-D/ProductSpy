# ProductSpy development contract

正式目标自 2026-10-17 起为 **Chrome MV3 Extension + Online SaaS Web Application + Cloud Backend**。本文件和 `docs/saas-requirements.md` 优先于历史本地/Windows 开发计划。不得将本地桌面发行链作为正式产品验收。

- 复用现有 Next.js/React/TypeScript/Zod、Amazon 采集器和业务 UI/schema。改栈须有代码和成本证据。
- 开发分支 `codex/saas-migration`；原始回退基线 `b83027a` 和 `codex/baseline-v1-before-saas`。不修改/合并主分支，不删除历史代码、发行包或真实数据。
- 默认 SaaS；`PRODUCTSPY_MODE=legacy` 和 `NEXT_PUBLIC_PRODUCTSPY_MODE=legacy` 仅用于历史回归。现有 Windows/JSON 代码保留为审计过的兼容实现。
- 生产使用 PostgreSQL。应用连接必须是 NOSUPERUSER/NOBYPASSRLS，使用独立迁移角色。每次业务操作强制服务器认证用户上下文、显式 user_id 条件和 RLS；禁止信任客户端 owner/plan。
- 生产启动须在接受业务请求前拒绝 SUPERUSER/BYPASSRLS 及可切换到这些角色的成员身份；禁止通过 PGlite 开发开关绕过生产要求。`db:migrate` 使用独立管理连接和原子事务，不得将管理连接注册到应用连接池。
- 保留幂等采集、分析 requestId、版本冲突检查。账户切换不得读取另一用户缓存/草稿/离线队列。扩展凭证只存在 trusted extension context 的 storage.session 内存，不回退到 local/sync；重启后重新授权不丢失原账号队列，不含 AI/支付服务器密钥。
- 扩展队列仅为上传 outbox，成功确认后不持久缓存完整云端商品；不得自动丢弃 pending 或未归属资料。已接受 AI 任务的 GET 轮询可按 Retry-After 有限退避，禁止因此重新提交 AI POST。
- 历史任务不能因最近记录上限而失去入口。按用户作用域进行稳定游标分页，保留 PostgreSQL 微秒时间，覆盖同时间/不同微秒、跨用户游标和翻页旧响应竞态。
- AI 调用前提交额度、任务和用量预留，失败/中断也计数；禁止自动重新发起可能收费的调用。Mock、fixture 和签名模拟都必须标注。
- 正式域名、付费资源、生产服务、真实支付、Chrome Web Store 和公开发布需要用户另行授权。允许本机可回退测试、修复和开发分支提交。
- 修改 Next 代码前读 `apps/web/AGENTS.md` 和已安装 Next 文档；遵循当前版本 API。
- 完成检查：typecheck、lint、format、unit/integration、build、SaaS browser/MV3 E2E、受限角色 PostgreSQL、多用户/额度/恢复。运行记录写 `docs/saas-validation.md`，保留失败与验证边界。
- 不得把本机数据库/多浏览器会话当成云部署/跨物理设备，把 Mock 当成真实 AI，把离线 Stripe 签名测试当成沙盒付款。

阶段状态与下一步见 `docs/saas-plan.md`。测试、修复、文档和后续阶段自主衔接，无须逐项等待确认。
