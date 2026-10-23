# AI 多渠道验证：2026-10-23

本轮已实现并更新到获授权测试站。应用源码 `5de92cb1af82d29aee7313ad7665352f158efd9d`，实际运行成功 CI 的 checkout `849d4d8a9135c8c699a1af96463a3520adc704f3`，tree `d516f57a6957fa343df609784114469ec9472dca`。专用渠道管理员已绑定并通过真实 HTTPS 浏览器登录；凭据交付在仓库外当前 Windows 用户私有文件，不公开邮箱、密码、主密钥或 Cookie。

- [最终完整 Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39897999086) **success**：1161 PASS / 16 SKIP（1177 项），受限 PostgreSQL 110/110，浏览器 5/5；typecheck、lint、全仓 format、备份恢复、默认构建、预览 ZIP、standalone、实际 Web/Worker 容器和原 Compose 均通过。包含实际 MV3、进程重启/离线恢复、本地 HTTP stub 渠道选择；Amazon HTML fixture、Mock 和 stub 均保留标记。
- 新测试镜像已核验 GitHub artifact SHA-256、source/tree、GCM 认证和加载后 config/rootfs 身份。RSA 私钥未离开本机。加密包 386,598,871 字节，明文压缩包 SHA-256 `cd136429ad9bbcaf141e4656c833c15a65620a316b045dc312232c739ea5fee4`。
- 2026-10-23 04:16–04:17 UTC 实际执行加密备份、停 Web/排空已接受任务、停 Worker、独立迁移角色原子迁移与新表授权，再只切换 Web/Worker。原数据库容器 ID 和自 10-19 的 StartedAt 未变；六张既有业务表的 count/checksum 在迁移前后完全一致，原六租户表与新平台配置表均 FORCE RLS。保留旧镜像和私有环境回退副本。
- 真实公网 HTTPS 管理员浏览器/API **47 项通过**：14 类预设、管理员权限、匿名 401/普通用户 403、Mock 目录、密钥不回显、保存后输入清空、刷新持久化和 375px 表单。暂存的 disabled 无效合成密钥经原始 PostgreSQL 查询证实仅为版本化密文（741 字节），不含合成密钥明文；随后清理本轮临时渠道，配置 revision 0 → 1 → 2，最终空配置 + Mock，未覆盖其他用户配置。无生成或外部浏览器请求。
- 更新后公网 API 边界 **6 项通过**，独立合成账号/商品 API 与新云端 Worker 的单次 Mock 任务、保存、第二会话读取和跨用户隔离 **9 项通过**。后者是实际 HTTPS/云端 PostgreSQL/Worker，商品为合成 fixture，AI 为 Mock，同一物理电脑；不代表真实 Amazon、真实 AI、物理跨设备或支付。
- Web/Worker 启动后受限应用角色、关闭自动迁移、Mock、无支付凭据、零 OOM/重启已实际复核。临时镜像导出标签已移除，未合并主分支、购买资源、修改生产或公开插件。

继续验收时补齐新平台配置的恢复证据：从实际云端 PostgreSQL 导出只读一致快照，在相同 snapshot 下核对全部 13 表并流式加密为 age；取得当前用户私有目录中的异地密文副本，SHA-256 `a9975c3303ada2359ddc3d07bbff7fb32ef8ba94f2e734bbca2e6765fe36ae20` 与云端相同。本机使用既有 SSH 私钥解密，输出经受固定主机密钥保护的 SSH 直接输入隔离库 `pg_restore`，私钥未传上服务器，两端未存储明文 dump。

恢复后 13 表 count/checksum 全部匹配，7 张 FORCE RLS 表保留；实际当前 Worker 镜像中的服务端函数以 `productspy_app` 连接隔离库，通过生产连接角色校验，使用独立保存的主密钥成功解密 revision 2 配置。普通作用域和仅用户作用域均不可直接读取平台配置，读取后的内部作用域已恢复；没有调用任何 AI。验证结束已清理临时环境副本和隔离库，当前业务数据库与服务未更换或停止。报告在忽略目录 `.test-data/saas/deployment/ai-config-recovery-report.json`。这是实际云端 SQL/服务端函数恢复与手工异地密文验证，不是恢复后的公网 HTTP、跨物理终端业务链路、自动异地复制或生产 RPO/RTO 演练。

两次初始恢复检查失败并已清理临时库：Docker 辅助管理命令继承了备份输入，提前消费归档流。修复验证脚本的 stdin 所有权后，使用同一份密文（未重新生成或替换数据）实际恢复通过；失败回执保留在专属备份目录，未降低校验条件或修改应用源码。

下述逐轮记录保留最初失败和当时状态；最新结论以上述最终结果为准。

用户选择“主流服务商都需要”“管理员统一配置，用户选择渠道和模型”，并授权 Codex 设置渠道管理员。复用现有 Next/React、AI schema、持久任务与额度，不增加客户端密钥。配置说明见 [渠道管理](ai-channels.md)，官方接口参考见 [服务商来源](ai-provider-sources.md)。

已实现 14 类服务商预设、Anthropic Messages 原生适配及 OpenAI 兼容适配、管理员页面、服务器 UUID 权限、AES-256-GCM 配置密文与并发版本检查。普通用户在商品分析、竞品分析、内容生成中选择白名单渠道/模型；结果与用量保留渠道/模型，既有记录继续可读。队列锁定配置，执行前拒绝失效配置，不自动切换渠道或重新调用；个人业务导出不包含平台密钥或任务内部配置。

本机运行记录：

- 初次全量单元/集成：109 文件，1161 PASS / 5 SKIP（其中 PostgreSQL 专用测试需另跑），包含渠道管理、传输、权限、队列、历史及备份。
- Next 16.4.1 升级后全量单元/集成仍为 1161 PASS / 5 SKIP；typecheck、lint 与扩展/Web 默认生产构建通过。
- 全仓 format:check 仅因原有未提交的验收矩阵格式改动失败，保留该改动。另检查本轮所有其他文件与矩阵的已提交基线，不将用户格式差异提交或覆盖。
- 本机临时 PostgreSQL 17.11：六组受限角色测试 110/110，包含渠道配置 FORCE RLS、未设置内部作用域不可读写、服务器权限恢复及扩展连接；独立角色迁移/重复迁移、生产高权限/可切换成员拒绝、逻辑备份和恢复均通过。自建集群已停止并清理，报告位于忽略目录 `.test-data/saas/windows-postgres/00f8ee88-314d-40a9-bd62-8b966c5103ce/report.json`。
- 实际浏览器多渠道流程通过：管理员保存两个本地 HTTP stub 渠道，用户选择第二个渠道及模型，后台只向选定地址发送一次请求，结果保存并刷新可读；普通用户管理页拒绝访问，目录不暴露密钥或端点。stub 响应不代表真实 AI 或付费调用。
- 初次本机 SaaS 浏览器共 3 PASS / 2 FAIL；失败均为 Windows 上加载实际 MV3 的 Chromium `launchPersistentContext: spawn UNKNOWN`，测试尚未执行业务步骤，保留失败。最终 Linux 浏览器 5/5 通过，未将 Windows 失败改写为成功。

发现并修复：全量旧业务回归最初 30 项失败，原因为把完整 AI 请求交给严格渠道选择 schema；现只提取 `channelId`/`model`，相关回归及上述全量重新通过。初次类型与 lint 问题也已修复，未跳过失败用例。

初次 Next 16.4.0 生产构建在完成编译后因已知安全提示退出 1。已按官方公告最小升级至 16.4.1，同步对应 SWC/env，保留原已修复的 sharp 0.35.5；生产构建通过，升级后实际浏览器三项 Web 流程 3/3 复跑通过。[官方 SVG 优化公告](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)、[官方 Cache Components 公告](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr)。

专用管理员账号已通过测试站 HTTPS 注册并于部署时绑定服务器 UUID 白名单；登录凭据与渠道加密主密钥保存在仓库外的当前 Windows 用户私有文件，未输出至聊天或 Git。用户登录资料文件只含登录资料，不含平台加密主密钥。

独立只读审查覆盖管理员鉴权、脱敏、RLS 事务作用域、模型白名单和任务幂等快照，未发现需要阻断的可证实问题；该审查不替代真实 PostgreSQL 与浏览器运行。功能提交 `37aca85` 的完整 Linux CI 已手工触发，等待实际结果；无自动部署至生产。

首轮最终文档提交 `90417c3` 的 [Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39833025253) 在 Compose 校验失败：旧断言要求整个 schema 恰好六张 FORCE RLS 表，而本次合法新增了第七张平台配置表。此前静态/完整单元（1150 PASS / 16 SKIP）、受限 PG（110/110）、恢复、默认构建、standalone 及实际 Web/Worker 容器检查均通过；后续浏览器与镜像导出未执行。现改为逐名验证六张租户表，并单独验证平台配置表、唯一内部作用域读写策略，以及回滚事务中的非空 canary 对无标记/用户上下文不可见、未授权写入被 RLS 拒绝，保留首轮失败记录。等待修复后的完整 CI，不将失败流水线记为通过。

第二轮 `25c9e57` 的 [CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39896327729) 发现校验器把 PostgreSQL `pg_policies.roles` 的 `name[]` 返回形式当作 JS 数组；node-postgres 实际返回 `{public}`。已通过本机临时 PostgreSQL 17.11 查询证实并增加回归，仅将精确 `{public}` 规范化为单个 public 角色，额外角色仍拒绝；读写策略和实际 canary 保护未放宽。第二轮其他已执行步骤仍通过，浏览器/导出未执行，继续等待最终完整流水线。

第三轮 `6d543df` 的 [CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39896974185) 已通过完整静态、单元、受限 PG、恢复、构建、standalone、容器及 Compose；浏览器 4/5 通过（多渠道、两项实际 MV3、工作台），任务历史用例在退出重登时发现嵌套 `next` 地址竞态。未放宽原 URL 断言：现改为使用当前浏览器路径构造一次登录跳转，忽略已到登录/注册/隐私页面的迟到失效通知，并增加重复账号通知及迟到 401 的回归。后续完整 CI 与部署仍待实际执行。

登录竞态修复的四项回归对旧实现为 4 FAIL，对新实现为 4 PASS；原实现已在负对照后恢复为修复版本，文件摘要核对一致。修复后本机全量为 110 文件、1172 PASS / 5 SKIP，typecheck、lint、扩展/Web 默认构建通过；实际任务历史/注册/退出/重登/375px 浏览器用例连续五次通过，保留原断言与真实本机 HTTP 会话。

私有部署准备阶段发现并修复：receipt 写入失败不得阻挡服务回退；原环境未变时不重复落盘，已变更时校验并原子恢复事先保存的副本，以覆盖可恢复的 ENOSPC 路径。四条合成恢复分支通过，不是实际云端故障演练。最初认证因传输助手裁掉 manifest 末尾换行而按设计拒绝，改为精确字节传输并核对摘要后 GCM 成功；镜像已成功加载时本机包装器误将 Docker 提示当 JSON，未重做加载，改为独立只读身份复核通过。上述准备故障没有触发服务切换；实际迁移/切换成功且未执行数据回退。

尚未完成：各服务商真实凭据、模型可用性/质量与计费调用、Stripe 沙盒付款，以及原始目标的公开运营前项目。用户原先要求稍后配置真实 AI，当前仍保持全局 Mock、支付关闭；管理员可准备保存配置，开启真实调用仍需明确测试预算和运维切换。不将 HTTP stub、Mock、密文配置保存记为真实 AI 验收，不进行真实交易或公开发布，整体阶段 10 尚未完成。
