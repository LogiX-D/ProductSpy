# Chrome Web Store 提交准备

本阶段补充真实环境验收、安全修复和提交资料草案。当前仍有下述人工验收及商店材料待办，未达到可直接提交审核的全部条件；未向商店提交、未支付注册费，也不承诺审核通过。自动化结果和真实页面限制见 [Phase 9 报告](phase9-validation.md)。

## 可供填写的说明

单一用途：用户主动采集 Amazon 商品资料到自己的本机素材库，并在自己的工作台分析商品营销内容。

权限用途：

| 权限                              | 当前实际用途                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| activeTab                         | 用户点击扩展后，只读取当前 Amazon 商品页                                                     |
| scripting                         | 将已打包的内容脚本注入当前授权标签                                                           |
| storage                           | 本机离线商品队列与工作台配对令牌，内容脚本不能访问                                           |
| localhost / 127.0.0.1 host access | 与用户本机工作台同步商品和完成配对；Chrome 匹配模式无法只限制到端口，程序实际地址固定为 3000 |

没有全站浏览权限、webRequest、cookies、history 或下载权限。Manifest V3、Service Worker、React 与解析器均包含在构建中，不使用 remotely hosted code、eval 或网页脚本执行。

公开隐私说明候选 URL：[ProductSpy 隐私说明](https://github.com/LogiX-D/ProductSpy/blob/main/PRIVACY.md)。提交者需确认商店可直接访问，按当前发布行为填写隐私披露和权限理由。真实 AI 会接收用户主动提交的商品文字，媒体展示和下载会请求对应 CDN；应明确披露这些传输。

开发者支持入口：[ProductSpy Issues](https://github.com/LogiX-D/ProductSpy/issues)。

## 安全与数据边界

工作台业务 API 使用同源 HttpOnly、SameSite=Strict 会话；扩展必须通过有效 2 分钟的一次性码配对，令牌绑定实际扩展 Origin，可撤销或重新配对。CORS 与写入来源校验均围绕本机工作台和已配对扩展，不向任意扩展开放素材库。页面内容脚本不能读取扩展令牌或离线队列。AI Key 仅由 Web 服务端读取；公开状态接口不返回 Key、令牌或配对码。

商品和配对配置在用户本机文件中；IndexedDB 是浏览器缓存。此方案保护浏览器来源边界，不能抵御已控制本机用户或读取本机磁盘的程序。localhost bridge 使用本机 HTTP，尚不是可部署到公网的服务。提交材料需如实说明安装本机工作台和完成配对的依赖，让审核人员能够复现功能。

## 尚须人工完成

1. 登录开发者 Dashboard，确认账号资格、联系信息、两步验证和商店表单。
2. 选择实际发布版本，执行全部检查，上传只含 `apps/extension/dist` 内容的扩展包；不要包含源码 `.env`、本地商品文件或 Chrome profile。
3. 提供真实 UI 的商店截图和宣传图、说明本机工作台安装及配对依赖。当前仓库有 16/32/48/128 PNG 图标，尚未制作商店专用截图和 440×280 宣传素材。
4. 核对商店页面及产品界面的显著数据说明，填写单一用途、数据使用及权限披露；说明采集的当前页面 URL / 商品资料、本机保存、真实 AI 传输与用户主动触发方式。向审核人员提供可复现的 Mock 工作台安装、配对、采集与分析步骤。
5. 自行提交审核，跟进审核结果。本项目未执行上架操作。

## 验收边界

真实商品测试记录见 [Phase 9 报告](phase9-validation.md)。测试在 Windows / Chrome for Testing 进行，不能等同于全部 Chrome 稳定版、macOS/Linux 和所有 Amazon 地区都验证通过。Amazon 可变 DOM、当前配送地区、已下架商品、验证码和 CDN 签名过期均可能影响字段可用性。未可靠匹配的关联商品视频会留空。

正式提交前仍应补一次常用 Chrome 稳定版的人工安装、真实页面切换与基本操作，并核实商店表单及政策。

2026-07-01 官方政策更新公告说明自 2026-08-01 起，采集、使用和传输的数据必须为已披露单一用途所必需，并加强显著披露要求。提交时应按现行规则核对页面采集、AI 服务传输及权限说明，不能只依靠隐私文档或自动化通过来判断是否满足审核要求。[官方政策更新](https://developer.chrome.com/blog/cws-policy-updates-2026)、[现行用户隐私政策](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting-user-privacy)。

其他官方依据（核对日期 2026-10-08）：[准备扩展](https://developer.chrome.com/docs/webstore/prepare)、[商店图片要求](https://developer.chrome.com/docs/webstore/images)、[用户数据与最小权限 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/)。
