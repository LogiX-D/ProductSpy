# SaaS Chrome 扩展发布准备

适用于当前迁移分支，替代旧 `docs/store/` 的 Windows 商店材料。这里只准备本机可审阅的 preview 包和文案；没有提交、发布、注册付费开发者账户或部署服务。用户当前指示“先审阅 PR，暂不部署”。

## 单一用途

用户主动采集当前 Amazon 商品资料，同步至本人 ProductSpy SaaS 商品库，供在线工作台管理、分析及内容创作。不需要 Windows 工作台，不自动遍历标签页或读取完整浏览历史。

## 本机准备

```text
pnpm package:saas:extension --environment development --origin http://127.0.0.1:3000
```

该命令独立构建并生成 `artifacts/saas/` 下的唯一 preview 目录。开发包明确标注 development，不能当成可公开发布的正式包。正式配置使用同一命令的 `--environment production --origin <已获授权的精确 HTTPS origin>`；不会代替域名授权、环境部署或商店提交。未知环境名、loopback 正式地址、额外权限、构建元数据不一致或秘密扫描失败均须停止打包。

新目录与旧 `ProductSpy-1.0.0-extension.zip`、Windows ZIP、Release 资产隔离，不覆盖旧稳定文件。旧 extension/Windows/store 打包入口在默认 SaaS 模式下拒绝执行；历史回退材料保留。包内根目录应含 `manifest.json`，所有执行代码随包交付，不包含 `.env`、源码映射、用户数据或服务端密钥。

本机打包和解包检查只证明格式、构建配置及文件一致性；不能证明实际服务器、Chrome Web Store 审核或所有可能的恶意代码检测。构建 metadata 是本机来源记录，不是数字签名或供应链认证。

## 提交资料

| 材料            | 当前来源与状态                                                                        |
| --------------- | ------------------------------------------------------------------------------------- |
| SaaS 产品介绍   | [中文说明草案](listing.zh-CN.md)                                                      |
| 权限与数据披露  | [披露草案](privacy-disclosures.md)，须与最终 Dashboard 逐字段核对                     |
| 审核步骤        | [SaaS 审核说明](reviewer-instructions.md)，正式环境和专用审核账号待准备               |
| 隐私政策        | [仓库开发预览](../../PRIVACY.md)；最终公开 URL、经营者、联系人、地域及保留期限未确定  |
| 实际截图/宣传图 | 尚无新 SaaS 商店来源包；本机 Mock 截图不能冒充真实 AI、正式云端或原生弹窗验收         |
| 版本与更新      | 提交前核对实际商店版本并选择可递增数字版；当前 preview 不授权覆盖既有 item 或发布版本 |

## 当前发布限制

正式 origin 与部署尚未获准执行；公开隐私联系人、保留期限/注销流程、审核环境及账号、正式 Chrome 稳定版、真实 AI 与跨设备证据仍须补齐。HTTPS 和数据库/备份静态加密、访问控制须在实际基础设施上验证，不能用本机明文临时库代替。沙盒支付和真实付款分别验收。

2026-10-17 已核对官方 [最小权限要求](https://developer.chrome.com/docs/webstore/program-policies/permissions)、[MV3 代码要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)、[用户数据披露 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)、[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) 和 [提交流程](https://developer.chrome.com/docs/webstore/publish)。本项目的实现核对不代表平台批准；真正提交前应再次核对届时政策和实际行为。
