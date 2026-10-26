# SaaS 权限与数据披露草案

状态：代码/用途核对记录，未在 Chrome Developer Dashboard 提交。最终填写须与实际公开产品和提供商一致。

| 权限                                | 当前用途                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `activeTab`                         | 用户点击扩展后读取当前支持的 Amazon 商品页，不获取常驻全站访问权限            |
| `scripting`                         | 注入扩展包自带的解析脚本，读取公开商品字段                                    |
| `storage`                           | 在 trusted extension context 保存账号授权信息、同意状态和按账号分区的离线队列 |
| `alarms`                            | 在 service worker 重启或网络恢复后恢复已保存商品的有限重试，不自动采集新页面  |
| 精确 SaaS origin 的 host permission | 向同一工作台的账号授权、采集提交和连接状态端点发请求；正式配置必须 HTTPS      |

未申请 history、cookies、webRequest、downloads、Amazon 全站或所有网站权限。开发 loopback 仅供本机测试，不是正式 SaaS 地址。[最小权限政策](https://developer.chrome.com/docs/webstore/program-policies/permissions)要求权限与当前功能对应。

| 数据类别      | 实际处理                                                                            |
| ------------- | ----------------------------------------------------------------------------------- |
| 个人身份资料  | SaaS 注册的邮箱、姓名；授权响应的账号标识供插件确认当前归属                         |
| 认证信息      | SaaS 密码只交给服务端；扩展通过当前网页登录取得可撤销 token，不接收密码或服务器密钥 |
| 网站内容      | 当前商品文字、价格/评分等字段与公开媒体链接；实际可用字段随页面变化                 |
| 浏览活动      | 被主动保存商品的 URL/ASIN；不因此宣称“完全不处理浏览活动”                           |
| 使用/任务资料 | 服务端保存同步事件、任务、用量和必要操作日志，供功能与异常恢复使用                  |
| 支付          | Stripe 启用后处理付款，ProductSpy 保存客户/订阅状态；扩展不保存支付卡或支付密钥     |

数据用于当前账号的商品库、同步、分析、创作及必要安全/可靠性处理。真实 AI 经用户确认才发送必要文字给配置的提供商；不把 AI 输出当成扩展代码执行。不会将用户资料出售或用于定向广告。人工支持读取、第三方转移和运营处理必须遵循公开承诺及 [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) 的限制，不能以“公开商品”跳过用户数据规则。

采集同意在扩展内发生于读取/保存前；[官方 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)要求清楚说明收集与用途，商店说明或隐私链接不能代替应有的界面同意。隐私政策仍须描述数据收集、使用与共享，以及实际保留/删除方式。最终 Dashboard 的类别名称和选项应逐项核对，不照抄历史本地版表单。

Remote code：当前实现的可执行逻辑随包交付，远端 API 返回账号/商品状态数据；未使用远端脚本、远端字符串执行或远端指令解释器。[MV3 要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)允许账户数据同步，但外部数据不能携带执行逻辑。自动扫描只能提供有限静态证据，不能声称平台已完成审核。

经营者、有效联系方式、正式供应商清单、地域、保留/删除期限和完整静态加密保护仍待确认，见 [隐私开发预览](../../PRIVACY.md)。测试主机可信 HTTPS、受限 PostgreSQL/RLS 与加密备份已取得 [实际证据](../saas-validation-2026-10-19.md)；正式生产的安全要求仍须另行验证，未完成前不将本草案标为正式可提交资料。

当前扩展安装后自动连接同一浏览器中已登录的 ProductSpy 账号，不再让用户输入扩展 ID 或复制配对码。只有专用连接端点使用浏览器附带的 ProductSpy 网站 HttpOnly Cookie；扩展脚本不读取 Cookie 内容，也未申请 `cookies` 权限。服务端根据有效网页登录和精确允许的扩展 Origin 签发或复用账号 token；其余扩展 API 请求只发送扩展 token，不附带网站 Cookie。没有有效网页登录时需先完成正常网页登录，不以缓存账号替代身份验证。

扩展 token 只写入 `chrome.storage.session` 内存，session/local 均设为 `TRUSTED_CONTEXTS`。浏览器重启或扩展更新、禁用、重新加载清空 session 存储后，下次连接会使用仍有效的网页登录自动恢复，无需重新配对；没有有效网页登录则先登录网站。service worker 暂停不要求重新登录。在扩展内主动退出会暂停本次浏览器会话的自动连接，用户可通过“刷新连接”重新连接当前网页登录。按账号分区的待上传队列仍保存在 local，只有重新验证原账号后才恢复该账号上传；切换到另一账号不会读取或上传原账号队列，未归属资料不会自动转给当前账号。生命周期依据见 [Chrome 存储文档](https://developer.chrome.com/docs/extensions/reference/api/storage)。

当前开发预览固定扩展 ID 为 `jhbdenjnkollamkdlombhjdhldciabpg`，后端连接端点精确限制允许的 ID。manifest 的公开 key 用于稳定预览身份，不是签名私钥，也不代表 Chrome Web Store 批准。旧预览可能使用不同扩展 ID：新实例不能自动读取旧实例的 local 队列，不提供跨 ID 自动迁移。旧实例仍有待同步资料时须保留该实例及其数据，待原实例、原账号完成同步或明确迁移后再卸载。同一实例中的历史 local 认证键仅在内存迁移成功后移除，不覆盖 pending/unassigned 队列；这不表示跨 ID 迁移，也不是历史磁盘残留安全擦除证明。

session 凭证减少认证 token 的持久存储，不等于本机队列、数据库卷和备份已完成全部静态保护；正式环境仍须验证实际保护，不能只凭 API 或部署模板作合规认证。

[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) 要求在扩展所属网站明确说明数据用途承诺。[隐私源码](../../apps/web/src/app/privacy/page.tsx) 和仓库隐私说明已补充该声明，覆盖用途、必要转移、广告限制及人工读取限制；工作台提供直接入口。源码/文档核对不表示新页面已部署、静态加密已完成或商店已批准。
