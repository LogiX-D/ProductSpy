# 2026-10-21 取消手工配对码

用户要求安装 Chrome 扩展后直接使用，取消工作台配对码。保留账号认证：同一浏览器已经登录 ProductSpy 网页时自动连接，未登录只需网页登录。SaaS 网页与扩展不再呈现扩展 ID、生成/复制/粘贴授权码；legacy 和旧 API 暂保留兼容，不删除历史数据。

## 实现与安全边界

- 新 `/api/bridge/connect` 仅允许精确可信 ProductSpy 扩展 Origin、正确 Host/JSON/client header。浏览器只在该端点携带工作台 HttpOnly/SameSite=Strict Cookie，服务器要求有效 `kind=web` 会话并在租户锁后复验；不能用现有 extension bearer、客户端 user/plan 替代网页身份。同用户同来源有效 bearer 复用，避免每次刷新产生新会话。
- 连接端点单独使用精确凭据 CORS；通用认证/CORS不放宽。业务上传继续 credentials=omit + bearer。凭证及暂停自动连接标记仅存 trusted storage.session，失败不回退到 local/sync。Cookie 失效后清理当前身份，网络异常只保留待上传资料，不使用未确认身份继续上传。
- SaaS 预览包公开 manifest key 固定 ID `jhbdenjnkollamkdlombhjdhldciabpg`，服务端默认精确允许该 ID，可用 `PRODUCTSPY_EXTENSION_IDS` 显式配置已核实的正式商店 ID；非法值拒绝。公开 key 不是服务器秘密或包签名证明。不新增 identity/cookies 权限，仍仅 activeTab/scripting/storage/alarms 与精确工作台 origin。
- 账号切换前后、实际上传前均确认网页账号，原账号 outbox 不转移给新账号。用户在扩展退出后会话内暂停自动连接，显式刷新可恢复；浏览器重启后可自动连接已登录网页。旧扩展第一次换为固定 ID 后属于另一个 Chrome 安装实例：旧队列保持原处，不自动迁移或删除，待同步资料应先在旧扩展与原账号下完成。

依据 Chrome 官方 [Cookie 行为](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies#partitioning-and-samesite-behavior)，有目标 host permission 的扩展请求可以发送 Strict Cookie，但用户 Cookie 设置可能阻止；未登录和未发送 Cookie 不作未经证明的原因区分。固定开发 ID 的用途见 [manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)。最终仍需真实 MV3 浏览器与 HTTPS 实测，单测不替代 Cookie 行为证明。

## 实际验证进展

后端定向真实 PGlite 31/31，UI 定向 32 项，打包边界 11/11，类型检查及默认 MV3/Next 16.4 Turbopack 构建已通过。新增实际 MV3 测试覆盖无网页登录、网页登录后自动连接、A→B 账号变更、保留网页登录的浏览器重启自动恢复、Cookie 丢失后不复用旧身份；原 E2E 保留实际断网、captureId 与 outbox 恢复。这些浏览器检查在提交前仍待 Linux CI，不在本机绕过浏览器工具限制。

首轮新 E2E 的共享包根路径类型解析与空 fixture 解构 lint 错误已修正。首轮 Vite 配置直接外部导入 shared 入口导致原有 extensionless 导出不能由 Node 解析，改用直接的公开 identity 模块后默认构建实际通过。后端测试的 count 类型差异、union header 类型及一次补丁定位失败已修正；没有把这些失败视为服务器失败或已通过。全量检查、CI 和测试站更新结果在取得后补充。

Mock 和关闭支付保持不变；真实 Amazon、物理设备、真实 AI 与 Stripe 沙盒仍遵循用户此前的推迟决定。取消手工步骤不等于已经完成原始全部最终验收或公开发布。

全量最终本机单测为 1066 PASS/4 SKIP（1070，102 文件），typecheck、lint、默认构建通过。本次文件 Prettier 已格式化；全仓 format:check 因进入任务前已有的 `docs/saas-acceptance-matrix.md` 未提交表格格式改动失败，该外来改动保留且不纳入本次提交。干净提交的完整格式和浏览器/网络 PG 验证仍交给 CI，不覆盖该文件来制造本机全绿。

初次实现 `1e32c80` 的 [完整 CI 39629589431](https://github.com/LogiX-D/ProductSpy/actions/runs/39629589431) 已实际运行：新自动账号浏览器测试通过（已有网页登录、A→B、保留网页登录的真实浏览器重启、Cookie丢失）；其他UI两项也通过，原扩展链路在离线保存后的旧“1件待同步”显示断言失败。新的安全逻辑离线不展示未经确认的旧账号队列，因此改为明确暂存反馈 + 真实storage outbox数量，恢复后仍要求上传并清空队列；没有放宽身份校验。另修复首次consent初始化观察竞态、将重启后网络监听提前到网页登录之前，保留原captureId只上传一次的断言。

初次云端 [39629579731](https://github.com/LogiX-D/ProductSpy/actions/runs/39629579731) fixture 在自动连接阶段未通过：服务器仍运行旧后端，尚不提供新connect端点。该失败保留，不当成新云端已验收；待完整CI通过并更新获授权测试服务后，复跑同一云端检查。真实Amazon仍独立记录，不能以fixture替代。

后续实现 `e8fafa0` 的 [完整 Linux CI 39632477534](https://github.com/LogiX-D/ProductSpy/actions/runs/39632477534) 实际 success：Linux 单测 1055 PASS/15 SKIP（1070）、受限 PostgreSQL 98/98、浏览器 4/4，包含完整自动连接、账号切换、真实进程重启、Cookie 丢失和离线原 captureId 恢复；typecheck/lint/format、备份恢复、默认构建、隔离 ZIP、standalone、实际镜像/容器及原 Compose 全部通过。实际 CI checkout `11dbae2e8f20e0780128c5de64cbf565ecbedc97`，tree `90c5f86e6b6318509eaf1210b4280837f13af55f` 与源提交一致。

独立干净 Git worktree 的全仓 format:check 也通过。首次在 worktree 直接打包因依赖 junction 的真实路径越出该工作树而被第三方 notice 路径门禁拒绝；保留该门禁，改用干净编译产物作为 `--source`、由原工作树的正常依赖目录生成 notices，243 文件 ZIP 校验通过，来源 e8fafa0/dirty=false。最终交付包会包含随后复核的扩展账号计数修复，不能将此中间包当最终包。

只读安全复核还发现既有 popup 两次异步读取之间可换账号：A 的 pending-count/error 先应用、B 的 bridge-state 后返回，会在 B 下暂留 A 的队列元数据。本轮自动账号切换扩大了触发机会，因此增加 verified userId 关联，SaaS 在同轮核对身份后一起应用，不匹配即清零；legacy 行为保留。deferred 回归证明 B 不显示 A 的计数/错误，随后可正确显示 B 的队列；该项是额外扩展修复，不改变已通过 CI 的 Web/Worker 源码。
