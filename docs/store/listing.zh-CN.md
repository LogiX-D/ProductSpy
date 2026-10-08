# Chrome Web Store 中文上架文案

对应版本：0.2.0。以下是可复制到开发者 Dashboard 的文案；当前尚未提交审核或发布商店安装链接。

## 扩展名称

ProductSpy

## 简短介绍

主动采集 Amazon 商品资料与公开素材，保存到本机工作台，生成商品分析、短视频脚本和 AI Prompt。需要 Windows 本地工作台。

此介绍小于 132 个字符。Manifest 的简短介绍也应符合该限制，最终上传版本须与包内名称、版本和介绍保持一致。[官方打包与 metadata 要求](https://developer.chrome.com/docs/webstore/prepare)

## 商店详细说明

ProductSpy 帮你把 Amazon 商品资料整理到自己的本机素材库，再围绕商品卖点规划营销内容。

**使用前需要安装并运行 ProductSpy Windows 工作台。** 工作台随便携包提供运行时，无需自行安装 Node.js 或 pnpm。启动后，与 Chrome 扩展完成一次安全配对，即可采集和保存商品。

你打开 Amazon 商品详情页并点击 ProductSpy 时，扩展读取当前商品 URL、ASIN、标题、价格、货币、品牌、图片、可靠匹配的公开视频链接、描述、卖点、评分及评分数量。保存由你主动触发，商品存储在自己的电脑上。

主要功能：

- 当前 Amazon 商品资料预览，支持有可靠页面信息时的图片和视频链接。
- 保存至本机商品库，按 ASIN 去重并更新商品资料。
- 搜索、网格或列表浏览、商品详情、图片查看与下载。
- 商品分析：总结、卖点、目标用户、购买动机、痛点、优势与弱点、营销角度和至少 5 条短视频 Hook。
- 五段短视频脚本，以及图片和视频生成 Prompt；内容可复制。
- 暂存未同步商品，工作台重新启动后可重试同步。

首次使用：

1. 下载 Windows 便携包，解压后双击 ProductSpy.cmd；工作台会在浏览器中打开。
2. 安装 Chrome 扩展，在工作台的扩展说明中生成一次性配对码。
3. 将配对码粘贴到扩展的「工作台配对码」，点击「连接工作台」。
4. 打开 Amazon 商品详情页，等待加载，点击扩展并保存。
5. 在工作台打开商品，点击「开始 AI 分析」。

不配置 AI Key 时提供明确标注的 Mock 演示分析，不调用外部 AI。若你配置自己的 OpenAI-compatible 服务并主动开始真实分析，本机工作台会向该服务发送商品文字资料；服务可能按其自身规则收取费用。真实 AI 输出和商家宣传均需人工核实。

数据与权限：只在你点击后读取当前 Amazon 商品页，不读取完整浏览历史、Amazon Cookie、登录信息、支付资料、配送地址或用户评论正文。扩展和工作台不运营远程商品数据库，不进行广告跟踪或出售数据。图片与视频展示会向相应 CDN 请求媒体。详见隐私说明。

当前仅支持 Amazon，没有价格监控、自动发布、账号系统或订阅支付。Amazon 页面、配送地区、变体、验证码、媒体过期和浏览器播放支持可能导致部分字段缺失。ProductSpy 不绕过登录、DRM 或站点保护。

这是独立开发的工具，与 Amazon、Google、TikTok、Meta 或 YouTube 没有官方隶属或背书关系。

## 链接

- 产品与 Windows 下载入口：[ProductSpy GitHub](https://github.com/LogiX-D/ProductSpy)
- 隐私说明：[PRIVACY.md](https://github.com/LogiX-D/ProductSpy/blob/main/PRIVACY.md)
- 安装与首次使用：[Windows 用户指南](https://github.com/LogiX-D/ProductSpy/blob/main/docs/windows-guide.md)
- 支持：[GitHub Issues](https://github.com/LogiX-D/ProductSpy/issues)

下载入口指向项目页；只有发布者实际上传的 Release 资产才可以称为可公开下载的便携包。提交商店前，应将审核说明中的包地址替换为已发布、无需登录且审核人员可访问的精确下载链接。
