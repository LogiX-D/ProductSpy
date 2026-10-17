> 历史本地版资料（v1.0.0 及此前）。正式产品现为 Chrome Extension + 在线 SaaS + 云端后端；当前要求、部署和隐私说明以仓库根 README、PRIVACY.md 及 docs/saas-*.md 为准。当前扩展材料见 [SaaS 发布准备](../saas-store/README.md)。本文件保留旧发行用法/证据，不作为 SaaS 发布材料。

# Chrome Web Store 材料目录

本目录最初于 2026-10-08 为 0.2.0 准备；2026-10-17 文案及权限说明的适用版本对齐 **1.0.0 / 扩展数字版 1.0.0.3**。原图片/来源清单保留其实际生成版本和日期，不能因文档版本更新就称为新版截图。本目录仍是未提交草案，未支付注册费用、未操作正式提交审核。维护者人工声明及公开前条件见[最终归档](../v1.0.0-final-manual-acceptance-results.md)。

| 材料                     | 位置 / 用途                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------- |
| 名称、简短介绍、详细说明 | [listing.zh-CN.md](listing.zh-CN.md)，可复制的中文商店文案                         |
| 单一用途、权限、数据类别 | [privacy-disclosures.md](privacy-disclosures.md)，Dashboard 填写依据               |
| 隐私政策                 | [../../PRIVACY.md](../../PRIVACY.md)，公开链接候选在披露文档中                     |
| 审核复现                 | [reviewer-instructions.md](reviewer-instructions.md)，需要精确的公开便携包下载地址 |
| 普通用户安装指南         | [../windows-guide.md](../windows-guide.md)                                         |
| ZIP 与图片资产           | 构建输出目录 `artifacts/`；精确名称、尺寸、哈希、截图来源以产物清单为准            |
| 宣传图矢量源             | [promotional.svg](promotional.svg)，原创品牌图形，不是产品截图                     |

## 图片要求与记录

官方要求包含 128×128 PNG 扩展图标、440×280 宣传图片，以及至少一张 1280×800 或 640×400 产品截图；截图应展示实际用户体验。[商店图片要求](https://developer.chrome.com/docs/webstore/images)

商品库、商品详情、分析和扩展截图必须来自实际运行的 ProductSpy；不能用设计稿、AI 生成界面或手写 HTML 假充截图。若截图使用 fixtures 或 Mock，应在资产来源记录中明确标注，不能说它们是真实 Amazon / 真实 AI 验收。宣传图可以是品牌图形，应与真实界面截图分别记录。

截图中的配对码、令牌、Cookie、API Key 和个人商品数据不能公开。商店图片不表示正式 Chrome 稳定版人工验收已经通过；截图浏览器版本与测试浏览器类型须在验收报告中分别写明。

## 发布前检查

1. 核对 `manifest.json`、商店文案和运行功能版本一致。ZIP 根目录须直接包含 Manifest。[官方扩展准备要求](https://developer.chrome.com/docs/webstore/prepare)
2. 在 Chrome 稳定版完成本机安装、配对、真实采集、Mock、断线恢复和重启验收，并记录实际结果。
3. 确认独立的 Windows 用户目录持久化测试及全部自动化检查通过，发布 ZIP 与哈希。
4. 核对最终截图、宣传图、权限与数据披露。用户数据收集和传输必须与单一用途、界面说明和政策一致。[现行政策](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting-user-privacy)
5. 发布无需登录的精确 Windows 包下载链接，供审核人员复现本机依赖；不能假设云端审核环境可以运行 Windows ZIP。
6. 发布者自行核对开发者账号、联系信息、两步验证、最终隐私 URL 和 Dashboard 表单；当前工作不代付或提交。

## 本次图片产物

| 输出路径（项目目录下）                         | 内容与来源                                      |
| ---------------------------------------------- | ----------------------------------------------- |
| `artifacts/store/screenshots/01-dashboard.png` | 1280×800 实际运行的打包工作台 Dashboard         |
| `artifacts/store/screenshots/02-library.png`   | 1280×800 实际运行的商品库                       |
| `artifacts/store/screenshots/03-analysis.png`  | 1280×800 实际运行的商品分析，明确标注 Mock 演示 |
| `artifacts/store/promo-440x280.png`            | 440×280 原创宣传图，由本目录 SVG 源生成         |

工作台截图使用 Chrome for Testing 与正常采集的 Amazon 公开商品，完整浏览器版本、商品来源和完成状态见 [Phase 10 报告](../phase10-validation.md)。扩展 Popup 另有 400×600 辅助截图，其比例不满足上述商店截图尺寸，不能直接当作上架截图上传。

这些为本机构建材料。GitHub draft Release 即使已附资产，也不能称为已公开发布或审核人员无需登录可下载的发行版。实际提交前需确认正式公开资产地址。

最终状态与未完成项由本次 [Chrome Web Store 准备说明](../chrome-web-store.md) 和 [Phase 10 验收报告](../phase10-validation.md) 记录；草案文件存在不等同于审核已通过。
