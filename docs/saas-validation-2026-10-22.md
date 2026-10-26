# 2026-10-22 原始目标复核与登录限流修复

上一目标轮次已完成取消 SaaS 手工配对码、获授权测试站 Web/Worker 更新和新扩展交付，属于实际进展。文档提交 `ed5ba9a` 的 [完整 CI 39636011554](https://github.com/LogiX-D/ProductSpy/actions/runs/39636011554) 也已实际 success；自动连接的业务证据仍分别使用 [10-21 记录](saas-validation-2026-10-21.md) 中的源码、运行与云端 job，不将文档提交当成再次部署。

## 限流缺口与回归

只读复核发现 `signIn` 先更新调用方邮箱对应的持久限流记录，再检查服务端全局限流。全局已满时，攻击请求可以继续用不同合法邮箱得到 429，同时每次新增邮箱限流行。新增真实路由与数据库回归在旧实现实际失败：四次已拒绝的 login/register 请求仍生成四条新记录。

最小修复把全局 200 次/分钟的检查移到邮箱 10 次/900 秒之前，不更改数值、schema、权限或账号逻辑。回归同时断言拒绝请求返回 429 与合理 Retry-After、不发 Cookie、不建用户、不增长邮箱限流记录。测试仅冻结 Date，在事务内设置合成全局计数并始终回滚，避免污染并行 PostgreSQL 测试或真实用户数据。

定向真实 PGlite 路由文件为 16 PASS/4 PG 专属 SKIP，Web typecheck、两文件 ESLint/Prettier 通过。全量和受限 PostgreSQL/浏览器/部署结果取得后补充，不能用该定向结果代替完整验收。本修复只防止全局已拒请求继续新增邮箱记录；既有记录的保留清理、全局服务可用性和长期规模仍须另行验证，没有删除历史数据或宣称整张表永久有界。

当前 Windows Node 24 完整单测实际 1068 PASS/4 SKIP（1072，102 文件），全仓 typecheck/lint、默认 MV3 与 Next 16.4 Turbopack 构建均通过。原有矩阵格式调整继续保留，索引中的语义更新单独按 Prettier 标准生成；完整干净格式与受限网络 PostgreSQL、浏览器由本次 CI 另行验证。

实现 `e545783` 的 [完整 Linux CI 39637407458](https://github.com/LogiX-D/ProductSpy/actions/runs/39637407458) 已实际 success。归档日志为 Linux 1057 PASS/15 SKIP（1072）、受限 PostgreSQL 99/99、浏览器/MV3 4/4；typecheck/lint/format、备份恢复、默认构建、隔离 ZIP、standalone、镜像/实际容器及原 Compose 全通过。新回归也在真实 PostgreSQL 应用角色执行，既有并发改密/撤销检查继续通过。独立干净工作树全仓 format:check 同样通过。

通过检查后导出的 artifact `12364525782`，CI checkout `8718b91cb61d2c7af523cc995c59c5739ad9af59`，tree `8bbdf75419148d1a8255f8745390d469248f27e7` 与源码一致；加密 ZIP SHA256 `2fc02119b74890336fa1e84881e8b9310e9040f61231322b15577d8321e06f34`。获授权测试站的来源/摘要/GCM 校验及可回退更新已完成，实际结果见下一节。临时镜像导出 label 已移除，避免文档提交重复传递镜像。

## 获授权测试更新与公网检查

该包已在目标主机下载并匹配源提交/tree/checkout、ZIP 与密文 checksum；本机仓库外 RSA 私钥仅解包一次性 AES key，通过已验证 SSH stdin 提交 key 和 manifest AAD，未传私钥。GCM 认证后的明文 SHA256 为 `b8328c6cde50227ee96b1e173934a79a8675ea47d3ae42a39bcd5546d84410f4`。加载后已按 CI config/rootfs 摘要验证 Docker 29 containerd 两镜像身份。

19:20:40 UTC 开始可回退更新：先完成 age 加密备份，再停止 Web，由旧 Worker 排空已接受 queued/running。19:21:11 UTC 新 Web/Worker 启动成功，来源 e545783/镜像 8718b91；Web healthy、无 OOM。数据库容器 ID 与 2026-10-19 启动时间未改变，无迁移或重建。更新前后 users（23）、workspace_documents（16）、subscriptions（23）、usage_events（18）、jobs（18）、capture_events（61）六表 count/checksum 一致；旧镜像、配置和备份保留。

更新后实际 HTTPS 六项检查通过：健康/隐私页 200、可信扩展匿名连接 401、可信 credentialed preflight 204、陌生网页/扩展来源 403 且不允许凭据 CORS，未绕过 TLS。随后核验应用角色仍为 productspy_app，NOSUPERUSER/NOBYPASSRLS、六表 FORCE RLS；Web/Worker 均 Mock、无 AI/Stripe 密钥、自动迁移关闭，无 OOM/重启。此处为 HTTP/服务器检查，实际 Chrome 云端 fixture 在更新完成后独立复跑，结果另记。

更新后 [cloud fixture job 119433556336](https://github.com/LogiX-D/ProductSpy/actions/runs/39634589746/job/119433556336) 实际 success：19:22:31–19:23:00 UTC，12 项均通过，包括注册、实际 MV3 fixture 提取、无配对码自动连接、session 内存凭证、实际 HTTPS 上传/商品库、单次 AI POST、独立云 Worker 保存 Mock、另一会话读取、其他账号 404、真实浏览器断网队列恢复。fixture HTML SHA256 `da4d55c7f07cd5b7e3a07fd891585843e26c4ee8860dee51e24b598a5e7a2685`；新增两个合成测试账号保留，未删除任何服务器数据。此处只重跑 fixture，独立 live job 保留原 CAPTCHA 失败，整个 workflow 仍不能称为全绿，更不能当作真实 Amazon/真实 AI/跨物理设备通过。

已比较 dfb5c43 与 e545783 的 apps/extension 和 packages/shared，源码完全一致；本次无需重发扩展，继续使用已交付的 243 文件 HTTPS 包。真实 Amazon、AI、支付和物理设备的验证边界不因该后端修复改变。

## 范围与保留

验收矩阵原先仍以 05cf4d3、旧配对码和后端 c481268 描述当前状态，现补入自动连接、dfb5c43 完整 CI、新包及 e8fafa0 测试更新的实际证据。原有未提交的表格格式调整保留在工作树，仅将从已提交版本派生的语义更新及标准格式放入索引；未把外来格式改动带入提交。

真人 Amazon/跨物理设备、真实 AI 凭据及预算、Stripe 沙盒配置继续遵循用户的推迟决定。保持 Mock、支付关闭；不购买资源、不公开插件、不变更生产、不合并主分支。每日加密备份已有运行证据，自动异地复制、外部告警和正式运营资料仍未完成；不擅自选择外部接收方或删除历史备份。原始最终验收仍未完成。
