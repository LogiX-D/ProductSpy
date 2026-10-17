# ProductSpy Chrome 扩展 SaaS 迁移

正式目标为 Manifest V3 扩展 + 在线 SaaS + 云端 API。现有 Amazon 采集器、ASIN 匹配、公开媒体识别及固定 400 × 420 弹窗保留。扩展不会接收密码、AI 服务密钥或支付密钥。

## 构建配置

默认 `pnpm --filter @productspy/extension build` 为 SaaS 的本地开发构建，工作台地址为 `http://127.0.0.1:3000`。加载 `apps/extension/dist`，不要直接加载源码目录。

| 环境变量                         | 用途                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| `VITE_PRODUCTSPY_APP_URL`        | 工作台精确 origin，不含路径、查询、凭据或通配符；非 loopback 地址必须 HTTPS |
| `VITE_PRODUCTSPY_ENV=production` | 正式构建校验，禁止 loopback 和 HTTP                                         |
| `VITE_PRODUCTSPY_MODE=legacy`    | 显式恢复旧本机配对/同步模式；只用于回退验证                                 |

构建时生成 manifest：SaaS 只授权该 origin；开发模式仅该 loopback 地址。`activeTab` 与 `scripting` 继续保持用户触发采集；`storage` 保存凭证与离线队列；`alarms` 在网络恢复后重新同步。没有远程执行代码、Amazon 广泛站点权限或服务端密钥。正式域名及公开发布仍需单独授权。

## 登录与上传

1. 用户打开弹窗中的「打开网页登录与授权」，工作台地址包含当前插件 ID。
2. 在已登录工作台生成 120 秒内有效的一次性授权码，并粘贴到插件。
3. 扩展向 `/api/bridge/pair` 交换绑定当前扩展 origin 的 30 天可撤销凭证和用户身份。凭证仅存于 extension-owned storage，设置 `TRUSTED_CONTEXTS`。
4. 采集后先保存当前用户的本地队列，再 POST `/api/products`，使用 `Idempotency-Key: captureId`。不向 API 传入可覆盖账号归属的 userId。
5. 收到匹配商品且队列修订仍相同时确认完成。请求前后均重新校验当前凭证，账号切换不会将原账号的在途结果写入新账号队列。
6. 退出调用 `/api/auth/logout` 撤销凭证后清除登录，保留原账号队列；相同账号再次授权后恢复。撤销失败时保留登录并提示重试，不声称已退出。

`GET /api/bridge/status` 验证已授权账号；公开 `/api/status` 仅验证健康与版本。扩展不读取用户全库、分析记录或备份。分析及账单由在线工作台提供。

## 恢复与历史记录

队列按 userId 分区。旧本机队列及未登录采集记录保持无归属，不会自动上传到新账号；弹窗提示用户重新采集并保存所需商品。旧文件与旧适配器保留用于回退。

网络失败、408、429 与 5xx 采用持久化指数退避，429 遵守 Retry-After；自动尝试最多 8 次，保留错误并允许用户显式重试。401 暂停并要求重新授权；其他永久 4xx 保留记录并暂停自动发送。服务 worker 重启后由 alarms 恢复。自动恢复只同步已由用户保存的商品，不自动读取 Amazon 页面。

## 验证边界

`pnpm test apps/extension` 覆盖既有采集器与弹窗回归，以及本地 HTTP mocks 下的账号隔离、在途账号切换、条件确认、幂等、429、持久重试上限、退出和过期。`pnpm --filter @productspy/extension typecheck` 与 `pnpm exec eslint apps/extension --max-warnings 0` 检查类型与代码。

这些本地测试不代表 Amazon 真网页、Chrome Web Store、真实 SaaS 部署、跨设备或支付交易验收；相关结果由总验收报告单独记录。
