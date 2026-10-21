# SaaS Chrome 扩展发布准备

适用于当前迁移分支，替代旧 `docs/store/` 的 Windows 商店材料。用户已授权并完成专属 HTTPS 测试部署，实际范围见 [测试部署记录](../saas-validation-2026-10-19.md)。本目录提供可审阅的 preview 包和文案；没有提交商店、公开发布插件或注册付费开发者账户。正式生产服务、域名及公开发布仍需单独授权。

## 单一用途

用户主动采集当前 Amazon 商品资料，同步至本人 ProductSpy SaaS 商品库，供在线工作台管理、分析及内容创作。不需要 Windows 工作台，不自动遍历标签页或读取完整浏览历史。

## 本机准备

```text
pnpm package:saas:extension --environment development --origin http://127.0.0.1:3000
```

该命令独立构建并生成 `artifacts/saas/` 下的唯一 preview 目录。开发包明确标注 development，不能当成可公开发布的正式包。正式配置使用同一命令的 `--environment production --origin <已获授权的精确 HTTPS origin>`；不会代替域名授权、环境部署或商店提交。未知环境名、loopback 正式地址、额外权限、构建元数据不一致或秘密扫描失败均须停止打包。

新目录与旧 `ProductSpy-1.0.0-extension.zip`、Windows ZIP、Release 资产隔离，不覆盖旧稳定文件。旧 extension/Windows/store 打包入口在默认 SaaS 模式下拒绝执行；历史回退材料保留。包内根目录应含 `manifest.json`，所有执行代码随包交付，不包含 `.env`、源码映射、用户数据或服务端密钥。

本机打包和解包检查只证明格式、构建配置及文件一致性；不能证明实际服务器、Chrome Web Store 审核或所有可能的恶意代码检测。构建 metadata 是本机来源记录，不是数字签名或供应链认证。

## 当前预览与登录流程

当前包目录为 `artifacts/saas/extension-production-7bcc737c-d105-45bb-86a7-3f2fc6029ead/`，来源 `dfb5c43`、`dirty=false`，共 243 个文件；SHA256 为 `169e70a4fb119ad0fdaa2dfcfa2956cdaf79e1a8cff1299c716b06e79334f36e`。该包用于获授权的 HTTPS 测试站。当前固定预览 ID 为 `jhbdenjnkollamkdlombhjdhldciabpg`，manifest 公开 key 仅用于稳定该身份，不是签名私钥或商店批准；正式商店 ID 须在确认后与后端精确允许名单一致。

安装后打开扩展，即可自动连接同一浏览器中已登录的 ProductSpy 账号，无需填写扩展 ID 或复制配对码。尚未登录时，先打开工作台正常注册或登录，再打开扩展或点击“刷新连接”。采集前核对扩展显示的账号；主动在扩展内退出会暂停本次浏览器会话的自动连接，刷新连接后恢复。重启或重新加载扩展后，内存凭证由有效网页登录自动恢复；网页登录失效时先重新登录网站。

旧预览可能使用不同扩展 ID。新实例无法自动读取旧实例的 local 待上传队列，也不会把未归属资料转给当前账号；同一实例的账号切换也只恢复经过验证的原账号队列。请保留仍有待同步资料的旧实例及数据，待原实例、原账号完成同步或明确迁移后再卸载。下面的旧包和配对记录保留为历史证据，不能替代当前包验收。

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

当前 production 配置预览包绑定获授权 HTTPS 测试 origin，已记录本机包的来源与 checksum。本轮云端 MV3 fixture 在 run `39634589746`、job `119342841700` 通过 12 项，包含无需配对码的自动网页登录、session 内存凭证、实际 HTTPS 上传、Mock worker、账号隔离和离线恢复。`dfb5c43` 完整 Linux CI 在 run `39634596583`、job `119342304357` 通过：1056 项通过/15 项跳过、受限角色 PostgreSQL 98/98、浏览器 4/4，以及构建、容器、Compose、恢复和格式检查；该次 CI 未导出镜像。真实 Amazon job `119342844937` 因 CAPTCHA 失败，不能用 fixture 代替实页通过。测试站保持 Mock AI、支付关闭。公开隐私联系人、保留期限/注销流程、正式审核账号、Chrome 稳定版人工链路、真实 Amazon、真实 AI 与跨物理设备证据仍须补齐。测试主机的可信 HTTPS、访问控制及备份加密已有实测；浏览器与数据库卷的完整静态加密尚未取得充分证据，须按官方安全要求完成发布前验收。沙盒支付和真实付款分别验收。

2026-10-17 已核对官方 [最小权限要求](https://developer.chrome.com/docs/webstore/program-policies/permissions)、[MV3 代码要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)、[用户数据披露 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)、[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) 和 [提交流程](https://developer.chrome.com/docs/webstore/publish)。本项目的实现核对不代表平台批准；真正提交前应再次核对届时政策和实际行为。

2026-10-20 再次核对前四项政策及现有 HTTPS 预览包。隐私页已补充明确的 Limited Use 用途承诺，以及桌面/移动工作台直接入口；c481268 的完整 Linux CI、加密镜像交付与实际测试站更新已通过，公网新页面已核对。完整静态加密及运营/正式审核资料仍未全部完成，详见 [当日记录](../saas-validation-2026-10-20.md)。

历史记录（已被当前自动连接包替代）：随后扩展 `05cf4d3` 将凭证改为受限 session 内存，当时 Chrome 重启或扩展更新后需重新配对，原账号待上传资料保留。该版本完整 CI 的真实浏览器进程重启恢复及云端 fixture 的内存/local 存储断言已通过。旧 HTTPS 预览包位于 `artifacts/saas/extension-production-6e554b13-ec7e-442f-b1cd-44e188d373bb/`，SHA256 `b1f31fbaf4ed159ce9f1d5b6e3bb6de1c07514da5281d09aa2118587e91085c1`，`dirty=false`；保留作历史回退，当前人工验收使用上方 `dfb5c43` 包。旧包未发布，该轮真实 Amazon CI 因验证码未通过；这些历史结果不证明本轮自动连接的云端或实页结果。
