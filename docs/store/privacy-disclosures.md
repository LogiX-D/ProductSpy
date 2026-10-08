# 商店隐私与权限披露草案

对应代码版本：0.2.0。用于填写 Chrome Web Store 的 Privacy practices。发布者应在 Dashboard 上核对实际字段，不能用「仅本地」作为不披露数据处理的理由。[官方隐私字段指南](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)、[用户数据 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/)

## 单一用途

用户主动采集当前 Amazon 商品资料与公开素材链接，保存到自己的本机商品库，并在自己的本地工作台生成商品营销分析。

## 权限理由

| Manifest 权限                          | 可填写的用途理由                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| activeTab                              | 用户点击 ProductSpy 时获得当前标签的临时授权，用于识别和读取当前 Amazon 商品资料；不扫描后台标签，不申请所有 Amazon 网站持续访问权。                       |
| scripting                              | 在已获 activeTab 授权的当前商品标签注入随扩展打包的解析脚本；不加载或执行远程 JavaScript。                                                                 |
| storage                                | 在 Chrome 本机存储保存未同步商品与本机工作台配对令牌，以便断线恢复；不使用 Chrome Sync，内容脚本不能读取这些存储。                                         |
| http://localhost/*、http://127.0.0.1/* | 与用户自己运行的本机工作台配对并同步商品，实际只请求 127.0.0.1:3000。Chrome 的 host match pattern 不能单独限制端口。商品业务接口仍验证配对令牌与扩展来源。 |

没有 history、cookies、webRequest、downloads、tabs 或 Amazon 全站 host 权限。使用普通标签 API 的部分功能不需要单独申请 tabs 权限；这不等于能读取任意标签的完整资料。

Remote code：选择 **No, I am not using remote code**。解析器读取并解码已有页面 JSON 数据，不执行页面 script 文本；AI 接口返回的是经过 schema 校验的数据，不是可执行代码。

## 数据类别的建议填写

| Dashboard 类别                            | 当前行为与建议                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website content / 网站内容                | **披露**。主动读取商品标题、价格、品牌、卖点、描述、评分、数量、商品及媒体链接，并保存到本机。                                                                                                                                                                                                       |
| Web history / 浏览活动                    | **披露选定页面 URL**。记录用户主动采集的 Amazon 商品 URL；不读取或保存完整 Chrome history，不持续监控浏览。类别标签以提交时 Dashboard 为准。                                                                                                                                                         |
| Authentication information / 身份验证信息 | **披露本机认证资料**。用户输入一次性配对码，扩展本机保存连接令牌，工作台保存其 SHA-256；Web 使用本机 HttpOnly 会话 Cookie。真实 AI Key 由本机工作台读取，扩展不接收 Key。没有 Amazon 登录信息采集。若 Dashboard 对应用自身令牌分类存在不同说明，应按该说明核对，不能误写「完全不处理任何认证信息」。 |
| Personally identifiable information       | 不主动采集姓名、邮箱、账号或配送地址。若用户主动采集的商品正文包含公开人物姓名，该文字仍作为网站内容处理；不做个人档案。                                                                                                                                                                             |
| Financial and payment information         | 不采集支付卡、银行账号、付款交易或订单；商品价格属于网站商品内容。                                                                                                                                                                                                                                   |
| Health information                        | 不采集用户健康资料；公开商品描述按网站内容处理。                                                                                                                                                                                                                                                     |
| Personal communications                   | 不读取邮件、聊天、评论正文或私信。                                                                                                                                                                                                                                                                   |
| Location                                  | 不读取定位或配送地址。价格可反映 Amazon 当前页面的配送上下文，但不会采集该地址。                                                                                                                                                                                                                     |
| User activity                             | 不记录鼠标、按键、点击轨迹或使用分析。主动采集当前页面 URL 已在浏览活动说明中披露。                                                                                                                                                                                                                  |

## 保存、传输与控制

商品资料先在扩展本机暂存，再经 loopback HTTP 发送到自己的工作台；保存于 Windows 用户数据目录，IndexedDB 为浏览器缓存。配对码有效 120 秒且单次使用，连接令牌绑定实际扩展 Origin，可撤销。存储未做应用级商品文件加密，Windows 使用当前用户目录 ACL，不能抵御已控制当前用户进程的本机程序。

本机扩展与本机程序间传输的加密例外见官方 FAQ 第 16 项；该例外不能推广成公网传输可使用明文 HTTP。远程 AI 应使用 HTTPS。[官方传输说明](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/)

Mock 不发送 AI 请求。用户配置真实 AI 后主动分析，文字资料传至其指定服务商；媒体展示和下载向 Amazon 对应 CDN 发起正常网络请求。开发者没有远程收集商品数据的服务，不出售数据、不用于广告定位，不转移给数据经纪商。用户可删除商品、撤销配对、卸载扩展或自行清理已备份的本机目录。

在 Dashboard 的数据使用承诺中，按当前实际行为确认：不出售用户数据；不将数据用于无关用途；不用于信用评估或借贷。隐私政策与产品界面也声明 Limited Use，且必须与实际发布行为一致。[现行用户隐私政策](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting-user-privacy)

隐私 URL 候选：[ProductSpy PRIVACY.md](https://github.com/LogiX-D/ProductSpy/blob/main/PRIVACY.md)。提交前由发布者确认其无需登录即可访问、内容为最终版本，并填写 Dashboard 专用隐私链接字段。
