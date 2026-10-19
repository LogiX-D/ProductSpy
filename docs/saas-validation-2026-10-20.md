# 2026-10-20 扩展披露及隐私入口复核

本轮接续已部署的获授权测试环境，保持 Mock、关闭支付；不改变生产、正式域名及公开发布的授权范围。此前实际云端 API、内容、备份及恢复结果见 [2026-10-19 记录](saas-validation-2026-10-19.md)。

## 发现与修改

- SaaS 商店 README 和审核步骤仍写“暂不部署”“尚无获准环境”，与后续测试部署授权冲突。已更新为获授权 HTTPS 功能测试预览；正式商店审核账号、运营资料和公开发布仍未完成。历史 PR 审阅记录保留原事实，增加时间与后续授权说明。
- 隐私页原有用途说明，但没有明确的 Limited Use 用途承诺；登录后的桌面/移动工作台也缺少持续可见的直接入口。源码已补充承诺、官方政策链接、两处工作台入口，并更新预览状态和日期。侧栏允许纵向滚动，保留短视口访问入口。现有 SaaS 浏览器测试增加从 1280×600 桌面及 375px 工作台直接进入隐私页的检查；该新增浏览器路径尚待实际 CI 执行。
- 生产构建生成的隐私 HTML 已实际读取，6 项通过：用途限制章节、官方链接、Limited Use 文本、更新日期、静态加密待验边界、获授权测试预览状态。这是构建产物检查，不是浏览器或云端部署证明。

## 实际检查

| 检查                      | 结果                 | 范围                                                                   |
| ------------------------- | -------------------- | ---------------------------------------------------------------------- |
| Typecheck / lint / format | PASS                 | 当前源码，包含隐私页、工作台入口及 E2E 源码                            |
| Node 24 全量单测          | 997 PASS / 4 SKIP    | 1001 项，98 文件；没有把网络 PG 或浏览器检查算在内                     |
| 默认生产构建              | PASS                 | MV3 Vite 与 Next 16.4 Turbopack，生成 /privacy；没有切换到替代构建器   |
| 生产隐私 HTML             | 6 项 PASS            | 实际 .next 产物，无浏览器、无云端页面更新                              |
| 已交付 HTTPS 扩展 ZIP     | 243 文件校验一致     | ZIP CRC、文件大小/checksum、编译源记录、Manifest、权限和秘密扫描       |
| 新增桌面/移动浏览器路径   | 待实际 CI            | 已有本机浏览器工具设置禁止 local browser use，未绕过设置启动本机浏览器 |
| 新隐私页云端部署          | 待镜像交付与部署验证 | 测试站当前仍为此前已验证镜像，不能把源码/文档改动写成新页面已上线      |

已交付预览 ZIP 的 SHA256 仍为 `ec9c67689da961e0c8f7a52e7a855146abf4fbb2bbfbb877bbb7fefc070f295f`，来源 `52ff575618b117dd5684cd00b3b0bdbb8f82369b` 且构建时 dirty=false。实际 Manifest 为 MV3，四项权限仅 activeTab/scripting/storage/alarms，host permission 为获授权 HTTPS 测试 origin，扩展页面 CSP 为 self。四个打包 JS 文件的静态检查未发现 eval、new Function 或 importScripts 调用；该扫描不是完整恶意代码分析或商店批准。插件逻辑没有因本轮隐私页修改而改变。

## 官方依据与未完成项

本轮重新阅读 Chrome 官方 [权限要求](https://developer.chrome.com/docs/webstore/program-policies/permissions)、[MV3 代码要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)、[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) 及 [安全与披露 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/)。它们要求最小权限、可从包内审阅的逻辑、明确的数据用途与同意，并在网站公开 Limited Use 承诺；FAQ 也明确要求传输及静态数据的保护。

测试 HTTPS、RLS、受限数据库角色和备份加密已有实际证据。Chrome 本机数据与数据库卷的完整静态加密保护尚未取得充分证据；TRUSTED_CONTEXTS 是访问隔离，不能作为已完成静态加密的证明。本轮将这一实际限制加入隐私说明，没有据此宣称已经满足全部商店安全要求。经营者、有效隐私联系人、正式托管地域及供应商清单、保留/注销流程、正式审核资料仍是公开运营前的门槛。

真实 Amazon、人用 Chrome、跨物理设备、真实 AI 和支付仍遵循用户已明确的推迟决定。整体最终验收保持未完成。新增页面应在完整 Linux 检查通过后，通过既有加密镜像交付流程更新获授权测试服务并核对实际页面；现有镜像、数据库和回退基线保持可用。

## 取得的实际 CI 日志

状态 API 与 job 日志一度不一致：查询 e527965 的 run 39282059178 / job 118158167833 仍返回 queued，但随后取得的完整日志已有 16:00–16:04 UTC 的实际执行及清理。日志证明该提交的 Python 6 项、Linux 单测 986 PASS/15 SKIP（1001）、受限 PG 67/67、浏览器 3/3、恢复、默认构建、两配置 ZIP、standalone、Docker 与原 Compose 检查通过；运行摘要终态另行核对。这些结果来自隐私页修改前的提交，不能代替本轮新增浏览器路径或新页面部署验证。

新诊断脚本的 [云端 run 39280331190](https://github.com/LogiX-D/ProductSpy/actions/runs/39280331190) 已取得实际报告：fixture job 118153117564 于 15:46:10 UTC 完成 PASS，仍是 10 项真实 MV3/云端链路检查。live job 118153117683 于 15:47:03 UTC 在 live-amazon 阶段失败，错误类别 TimeoutError；HTTP 200、document complete，但标准/备用商品标题均不存在，captchaFormPresent=true，signInFormPresent=false。这里只据布尔 DOM 证据确认页面含验证码表单，不推断 IP 封禁或尝试绕过。没有真实商品采集/上传成功证据，整体云端真实链路未通过。日志只含页面摘要、类别和布尔特征，没有发布页面正文、URL query、表单值或凭据。
