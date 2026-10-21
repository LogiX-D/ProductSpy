# ProductSpy SaaS 隐私说明（开发预览）

2026-10-20。当前产品为 Chrome MV3 扩展、在线 SaaS 工作台与云端服务。本说明替代原本地架构；[旧 v1.0.0 隐私快照](docs/legacy-v1-privacy.md) 仅作历史记录。已部署获授权测试预览，尚未正式公开运营；公开运营前必须补齐经营者、有效隐私联系人、实际托管地域、保留期限、账户删除流程与供应商清单。商店审核仍未进行。

用户点击并同意后，扩展读取当前 Amazon 商品页的 ASIN、URL、标题、价格、货币、品牌、商品图片/可靠匹配的公开视频 URL、描述、卖点、评分和评分数。用途是建立当前用户商品库、分析与内容创作。不会批量读取浏览历史、Cookie、Amazon 登录凭据、支付卡、配送地址或评论正文。

注册保存邮箱、姓名、带随机 salt 的 scrypt 密码哈希和时间；服务器保存会话 token 哈希，浏览器使用 HttpOnly/SameSite Cookie，HTTPS 生产附 Secure。Chrome 扩展自动连接同一浏览器中已登录的 ProductSpy 账号，无需配对码；仅连接端点由浏览器携带工作台 Cookie，扩展不读取 Cookie 内容、不申请 cookies 权限。服务器校验可信扩展来源和网页会话后返回可撤销、绑定扩展 origin 的 token，仅保存于受限 `chrome.storage.session` 内存；扩展不保存 AI 或支付服务端密钥。Chrome 重启清空会话后可自动连接已登录网页，待同步资料按原账号保留。[Chrome 存储文档](https://developer.chrome.com/docs/extensions/reference/api/storage) 说明了会话存储生命周期。

采集数据、商品/分析/创作/模板/竞品及其历史、任务、额度、套餐和必要操作日志保存于服务端 PostgreSQL，按用户隔离。Chrome 离线队列持久保存在受限 `chrome.storage.local`，按账户分区，网络失败有限退避重试；退出不删除未同步队列，同一账号再次授权可恢复。旧版无 owner 队列不会静默上传给新账号。旧扩展的本机认证键在成功迁移到会话内存后移除，其他队列不受影响；逻辑移除不保证历史磁盘残留已安全擦除。SaaS 不使用共享 IndexedDB 存储业务正文；编辑草稿可能在当前浏览器临时保存，账户切换会清理/隔离。

真实 AI 仅在用户于工作台确认后调用。服务器向配置的 AI 服务发送生成所需商品文字与创作参数，当前不做图片/视频识别；模型输出需人工核验。Mock 明确标记，不调用真实模型。失败/中断也计入请求额度，服务商费用可能未知，不自动收费重试。

支付配置后，结算和账单管理跳转到 Stripe 托管页面；ProductSpy 保存客户/订阅标识、状态、期限和事件去重记录，不保存卡号等支付凭据。沙盒与真实交易分别验证，真实支付需要另行启用授权。

用户可查看/编辑/删除商品、导出业务备份；登录或授权撤销和改密会使会话失效。完整账号注销、联系渠道、数据库备份保留与彻底清除时限在公开运营前补齐，不承诺当前实现尚未提供的删除能力。生产日志不得记录密码、token、AI Key、支付 Key 或完整敏感正文。备份包含账户/业务信息，需加密和限制访问。

扩展可执行逻辑随包交付，不从云端下载执行代码。采集与账号数据只用于上述用户功能，不出售用户数据或用于广告定向。实际权限、处理用途和公开说明须与 Chrome Web Store 提交一致；[官方政策](https://developer.chrome.com/docs/webstore/program-policies/policies) 与 [MV3 要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) 是核对依据。

我们对通过扩展获得的信息的使用遵守 Chrome Web Store 用户数据政策中的 [Limited Use 要求](https://developer.chrome.com/docs/webstore/program-policies/limited-use)：仅为已披露的商品采集、同步、分析、创作及必要安全和可靠性处理使用数据。第三方传输仅限于提供这些功能、必要安全处理或法律要求；人工读取仅限于用户明确同意的支持、必要安全调查或法律要求。该用途承诺不替代实际基础设施安全验收或商店审核。

测试环境已实测可信 HTTPS、按账号访问控制和加密备份。扩展 `TRUSTED_CONTEXTS` 限制存储访问；浏览器本机数据、数据库卷及其底层磁盘的完整静态加密保护仍待发布前验证，未据此声明已满足全部安全要求。[官方安全 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/) 分别说明传输、静态保护、显著披露和用户同意的要求。
