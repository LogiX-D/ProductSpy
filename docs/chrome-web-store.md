> 历史本地版资料（v1.0.0 及此前）。正式产品现为 Chrome Extension + 在线 SaaS + 云端后端；当前要求、部署和隐私说明以仓库根 README、PRIVACY.md 及 docs/saas-*.md 为准。本文件保留旧发行用法/证据，不作为 SaaS 发布材料。

# Chrome Web Store 提交准备

> 当前适用范围：1.0.0（Manifest 数字版 1.0.0.3）；正式文件名为 `ProductSpy-1.0.0-windows-x64.zip`、`ProductSpy-1.0.0-extension.zip`，既有哈希及草稿附件未变。[商店材料目录](store/README.md)、[隐私披露](store/privacy-disclosures.md)和[最终人工归档](v1.0.0-final-manual-acceptance-results.md)提供当前文档入口。维护者已声明53/53 PASS，但没有提供完整逐步骤/真实AI附件；未提交商店、未复核未来提交时的全部政策。**下文保留0.2.0/Phase10原准备记录，包括当时未发现Chrome和旧包名，属于历史事实，不代表当前安装环境或待验收数量。** GitHub公开发布与商店提交分别需要维护者另行决定。

ProductSpy 0.2.0 提供 Windows x64 便携工作台与 MV3 Extension ZIP，保留 Phase 9 的会话认证和一次性安全配对。本阶段准备可复用的商店材料，**未支付注册费用、未操作正式提交审核、未获得审核通过**。

## 提交材料

| 材料                         | 实际来源                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| 扩展名称和简短介绍           | `apps/extension/manifest.json`，名称 ProductSpy，介绍不超过 132 字符               |
| 中文商店详细说明             | [store/listing.zh-CN.md](store/listing.zh-CN.md)                                   |
| 单一用途、权限理由、数据披露 | [store/privacy-disclosures.md](store/privacy-disclosures.md)                       |
| 隐私政策                     | [PRIVACY.md](../PRIVACY.md)；公开候选链接为 GitHub 的 main 版本                    |
| 审核复现步骤                 | [store/reviewer-instructions.md](store/reviewer-instructions.md)，不需要账号或 Key |
| Windows 首次安装、配对与更新 | [windows-guide.md](windows-guide.md)                                               |
| 可上传扩展 ZIP               | `artifacts/ProductSpy-0.2.0-extension.zip`，构建后根目录直接包含 Manifest          |
| Windows 便携 ZIP             | `artifacts/ProductSpy-0.2.0-windows-x64.zip`，双击 ProductSpy.cmd 启动             |
| 图标、真实界面截图与宣传图片 | 本次构建的 `artifacts/store/` 与资产清单；截图来源和版本以本次验收报告为准         |

分发包、校验文件与图片是本机构建产物，Git 不包含用户数据、Key 或浏览器 profile。公开下载需发布者将对应 Release 资产实际上传，不能把源码仓库下载链接写成现成安装包。资产存在与符合尺寸要求也不意味着已通过商店审核。

## 单一用途与权限

用途：用户主动采集当前 Amazon 商品资料和公开素材链接，保存到自己运行的本机商品库，并在本地工作台生成商品营销分析。

| 权限                              | 当前实际用途                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| activeTab                         | 点击后读取当前 Amazon 商品标签，不持续读取全部标签或浏览历史                              |
| scripting                         | 注入随包提供的解析脚本；不执行远程代码                                                    |
| storage                           | 保存本机待同步商品和配对令牌，内容脚本无权读取                                            |
| localhost / 127.0.0.1 host access | 与本机工作台完成配对和同步；程序实际固定为 127.0.0.1:3000，match pattern 本身无法限制端口 |

没有 Amazon 全站 host 权限、history、cookies、webRequest 或 downloads 权限。扩展 / React / Service Worker / 解析器全部包含在构建中，不使用 remotely hosted code、eval 或页面 script 执行。

商品 URL 属于选定页面的浏览活动，商品文字与媒体链接属于网站内容；不能因仅本地存储就省略数据披露。本机配对码、令牌和 Web 会话也需要在认证资料说明中如实解释。Mock 不发送 AI 请求；配置真实 AI 后主动分析会发送商品文字至用户指定服务，媒体展示和下载会请求相应 CDN。详见数据披露草案与隐私政策。

## 安全与本机依赖

业务 API 要求同源 HttpOnly、SameSite=Strict 会话或配对令牌；配对码有效 120 秒且单次使用，令牌绑定真实扩展 Origin，可撤销。工作台重启后令牌由独立用户目录载入；未同步商品在失败时保留。Windows AI 设置采用 DPAPI CurrentUser 保护，分发包不含 API Key。

本机 bridge 使用 loopback HTTP。官方用户数据 FAQ 第 16 项说明同机扩展和 native 程序间传输的加密要求例外；不能据此将当前 API 公开部署，远程 AI 应用 HTTPS。[官方 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/)

本机商品文件仍未做应用级加密，不能抵御已控制当前 Windows 用户或磁盘的程序。发行版安装与更新不覆盖 `%LOCALAPPDATA%\ProductSpy\data`。审核说明必须告知需运行 Windows 工作台，不能用「装好扩展即可无需配套软件」的误导宣传。

## 当前审核阻塞与发布者步骤

1. **Chrome 稳定版完整验收待完成。** 当前运行环境未发现正式 Chrome 稳定版安装，Chrome for Testing 的真实运行截图和自动化不能替代稳定版人工加载、配对、Amazon 采集、断线重连及重装数据保护验收。以 Phase 10 报告记录为准。
2. **审核可复现的公开下载地址待发布。** 审核人员需能下载 Windows 便携包并运行本机工作台；未提供精确的无需登录下载地址，或其环境无法运行 Windows 本机程序时，完整链路不能复现。这是实际提交阻塞，不能以 Mock 截图掩盖。
3. **Dashboard 由发布者完成。** 核对开发者资格、联系信息、两步验证、最终版本、支持链接、最终隐私 URL、单一用途、权限理由与数据使用承诺；当前草案不等于表单已提交。
4. 核对最新产物与 SHA-256，确保截图显示实际运行界面且公开内容不含配对码、Key、个人数据。使用品牌宣传图时不把其称为真实截图。
5. 发布者自行决定何时提交及处理反馈，本阶段不支付费用或提交审核。

公开隐私候选：[ProductSpy 隐私说明](https://github.com/LogiX-D/ProductSpy/blob/main/PRIVACY.md)。支持：[GitHub Issues](https://github.com/LogiX-D/ProductSpy/issues)。

## 官方要求依据

官方要求上传 ZIP 的根目录包含 Manifest，名称、版本、描述和图标应一致，生产功能应先本地验证；介绍最多 132 个字符。[准备扩展](https://developer.chrome.com/docs/webstore/prepare)

图标为 128×128 PNG；必需宣传图为 440×280；至少提供一张真实体验截图，尺寸 1280×800 或 640×400。[商店图片要求](https://developer.chrome.com/docs/webstore/images)

Dashboard 的权限、单一用途和数据表单需与实际行为及隐私政策保持一致；本机处理也需披露，不能只填「开发者不收集」来略过扩展本机采集。[隐私字段指南](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)、[用户数据 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/)

现行规则限制数据仅用于已披露的单一用途，要求显著说明数据处理与用户主动同意。最终提交者需核对发布时政策及界面，不能把自动化通过当成合规结论。[现行用户隐私政策](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting-user-privacy)

上述官方资料核对日期：2026-10-08。Phase 9 真实页面数据见 [历史报告](phase9-validation.md)；Phase 10 的实际检查和剩余问题见 [本次验收报告](phase10-validation.md)，不重写历史结果。
