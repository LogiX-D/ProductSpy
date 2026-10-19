# 2026-10-20 扩展披露及隐私入口复核

本轮接续已部署的获授权测试环境，保持 Mock、关闭支付；不改变生产、正式域名及公开发布的授权范围。此前实际云端 API、内容、备份及恢复结果见 [2026-10-19 记录](saas-validation-2026-10-19.md)。

## 发现与修改

- SaaS 商店 README 和审核步骤仍写“暂不部署”“尚无获准环境”，与后续测试部署授权冲突。已更新为获授权 HTTPS 功能测试预览；正式商店审核账号、运营资料和公开发布仍未完成。历史 PR 审阅记录保留原事实，增加时间与后续授权说明。
- 隐私页原有用途说明，但没有明确的 Limited Use 用途承诺；登录后的桌面/移动工作台也缺少持续可见的直接入口。源码已补充承诺、官方政策链接、两处工作台入口，并更新预览状态和日期。侧栏允许纵向滚动，保留短视口访问入口。现有 SaaS 浏览器测试增加从 1280×600 桌面及 375px 工作台直接进入隐私页的检查，已在本轮 Linux CI 实际通过。
- 生产构建生成的隐私 HTML 已实际读取，6 项通过：用途限制章节、官方链接、Limited Use 文本、更新日期、静态加密待验边界、获授权测试预览状态。这是构建产物检查，不是浏览器或云端部署证明。

## 实际检查

| 检查                      | 结果              | 范围                                                                 |
| ------------------------- | ----------------- | -------------------------------------------------------------------- |
| Typecheck / lint / format | PASS              | 当前源码，包含隐私页、工作台入口及 E2E 源码                          |
| Node 24 全量单测          | 997 PASS / 4 SKIP | 1001 项，98 文件；没有把网络 PG 或浏览器检查算在内                   |
| 默认生产构建              | PASS              | MV3 Vite 与 Next 16.4 Turbopack，生成 /privacy；没有切换到替代构建器 |
| 生产隐私 HTML             | 6 项 PASS         | 实际 .next 产物，无浏览器、无云端页面更新                            |
| 已交付 HTTPS 扩展 ZIP     | 243 文件校验一致  | ZIP CRC、文件大小/checksum、编译源记录、Manifest、权限和秘密扫描     |
| 新增桌面/移动浏览器路径   | CI 3/3 PASS       | Linux CI 已运行 1280×600 / 375px 路径；本机浏览器设置未绕过          |
| 新隐私页云端部署          | PASS              | c481268 镜像已实际更新，外部 HTTPS 9 项通过；详见下方交付记录        |

已交付预览 ZIP 的 SHA256 仍为 `ec9c67689da961e0c8f7a52e7a855146abf4fbb2bbfbb877bbb7fefc070f295f`，来源 `52ff575618b117dd5684cd00b3b0bdbb8f82369b` 且构建时 dirty=false。实际 Manifest 为 MV3，四项权限仅 activeTab/scripting/storage/alarms，host permission 为获授权 HTTPS 测试 origin，扩展页面 CSP 为 self。四个打包 JS 文件的静态检查未发现 eval、new Function 或 importScripts 调用；该扫描不是完整恶意代码分析或商店批准。插件逻辑没有因本轮隐私页修改而改变。

## 官方依据与未完成项

本轮重新阅读 Chrome 官方 [权限要求](https://developer.chrome.com/docs/webstore/program-policies/permissions)、[MV3 代码要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)、[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) 及 [安全与披露 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/)。它们要求最小权限、可从包内审阅的逻辑、明确的数据用途与同意，并在网站公开 Limited Use 承诺；FAQ 也明确要求传输及静态数据的保护。

测试 HTTPS、RLS、受限数据库角色和备份加密已有实际证据。Chrome 本机数据与数据库卷的完整静态加密保护尚未取得充分证据；TRUSTED_CONTEXTS 是访问隔离，不能作为已完成静态加密的证明。本轮将这一实际限制加入隐私说明，没有据此宣称已经满足全部商店安全要求。经营者、有效隐私联系人、正式托管地域及供应商清单、保留/注销流程、正式审核资料仍是公开运营前的门槛。

真实 Amazon、人用 Chrome、跨物理设备、真实 AI 和支付仍遵循用户已明确的推迟决定。整体最终验收保持未完成。新增页面已在完整 Linux 检查通过后，通过既有加密镜像交付流程更新获授权测试服务并核对实际页面；原镜像、数据库和回退基线保持可用。

## 取得的实际 CI 日志

状态 API 与 job 日志一度不一致：查询 e527965 的 run 39282059178 / job 118158167833 仍返回 queued，但随后取得的完整日志已有 16:00–16:04 UTC 的实际执行及清理。日志证明该提交的 Python 6 项、Linux 单测 986 PASS/15 SKIP（1001）、受限 PG 67/67、浏览器 3/3、恢复、默认构建、两配置 ZIP、standalone、Docker 与原 Compose 检查通过；运行摘要终态另行核对。这些结果来自隐私页修改前的提交，不能代替本轮新增浏览器路径或新页面部署验证。

新诊断脚本的 [云端 run 39280331190](https://github.com/LogiX-D/ProductSpy/actions/runs/39280331190) 已取得实际报告：fixture job 118153117564 于 15:46:10 UTC 完成 PASS，仍是 10 项真实 MV3/云端链路检查。live job 118153117683 于 15:47:03 UTC 在 live-amazon 阶段失败，错误类别 TimeoutError；HTTP 200、document complete，但标准/备用商品标题均不存在，captchaFormPresent=true，signInFormPresent=false。这里只据布尔 DOM 证据确认页面含验证码表单，不推断 IP 封禁或尝试绕过。没有真实商品采集/上传成功证据，整体云端真实链路未通过。日志只含页面摘要、类别和布尔特征，没有发布页面正文、URL query、表单值或凭据。

## 实际镜像交付与测试站更新

[c481268 的完整 CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39284478785) 已实际完成且运行摘要为 success：Python 6/6、Linux 单测 986 PASS/15 SKIP、PG 67/67、浏览器 3/3，包含新隐私入口；恢复、默认构建、ZIP、standalone、Docker 与原 Compose 均通过。实际 checkout 为 `72ac8db7ffbc1fb66627a0c9d004deb2ef48c94f`，tree `5f10c05e4b266cc2b5c2367b2fcc75b97b8b2a0b` 与源码提交精确一致。云端 run 39280331190 的摘要也已确认 failure；不再把此前不一致的 queued 状态作为当前执行状态。

同一质量 job 成功后导出的加密 artifact ID 为 12202538841，ZIP 385,611,501 字节，SHA256 `8e99030b11a06c545ab36bf76d09405a9d2598f243531186bc38261fb335cea4`。下载启动命令首次因 PowerShell 转义错误失败，未启动下载或修改服务；修正后测试服务器实际下载并校验 ZIP、三个固定条目及 SHA256SUMS。密文 385,608,435 字节，SHA256 `cd911ece3c23ab9b3cd9ff1277c74acb07c994b27716782c36a6f048496d05a0`。RSA 私钥保留本机，解出的单次 AES 密钥仅通过已认证 SSH stdin 传递；GCM 成功后归档 SHA256 为 `77ba217eb7cedf199fa44e31d4a833910267ecb636d0f82899a78d2c064d1380`。未将私钥交给服务器。

镜像导入时服务继续运行；Web/Worker 均经 Docker 29 manifest→CI config→rootfs 摘要核对通过，随后才更换服务。2026-10-19 16:35:50–16:36:10 UTC，先生成新的加密备份，再停止测试 Web 阻止新任务进入；旧 Worker 排空已接受任务后切换两镜像。没有执行迁移、没有重建数据库，数据库容器 ID 与原 `15:18:41 UTC` 启动时间保持一致。保留旧 c640249d 镜像、私有环境副本与原数据库用于回退；没有删除原有资料。

公网更新后 9 项检查于 16:37:15 UTC 完成 PASS：可信 HTTPS 新隐私页面及官方链接、静态保护待验说明、服务器仍为 Mock、原双账号登录/Secure Cookie、原两版内容及历史 checksum、跨用户隔离、新镜像 Worker 完成一次新 Mock 任务、用量仅加一、商品分析不改写既存内容快照。此次仅一个 AI POST，authorizeReal=false，没有自动重放。更新前页面没有 Limited Use，SHA256 `122aeae33d7b2daa5cfabe5f1f47f0db3fb739f449b2781ee7041bf0b443361b`；更新后包含该声明，HTTP 200、TLS 1.3 校验成功，SHA256 `00c2504d4e13e5f16580b3bbce663478dea37a715d837354964a95ab8168a7d1`。这组云端页面验证是实际 HTTP，不声称已经完成人用 Chrome/跨物理设备验收。

更新后一次采样：Web 103MiB、Worker 85.36MiB、DB 36.75MiB，主机 available 342MiB、swap 已用 132MiB、根盘剩余 17GiB；两应用容器 OOM=false。此采样不代表峰值、负载容量或 SLA。备份与证书 timer 均 active。镜像导出标签已移除，避免后续仅文档提交重复上传大包。
