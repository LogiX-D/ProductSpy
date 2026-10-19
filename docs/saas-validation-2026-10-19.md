# 2026-10-19 授权测试部署记录

本次接续已完成的 SaaS 迁移，不从零重写。用户指定 CloudCone 测试主机并允许专属容器、数据库和 HTTPS；生产/付费/正式域名/公开发布仍未授权。此页随实际验证更新，不能将准备工作写成已部署。

## 已确认

- 实际 SSH root 密钥认证成功，私钥仅保存在本机仓库外。主机访问资料、known_hosts、配置和原始记录仅存忽略目录，不在提交中。
- Ubuntu 24.04 amd64、2 vCPU，物理 RAM 961MiB，swap 1GiB；初检 available 333MiB，根盘剩余 24GiB。已有 x-ui/xray 使用 443，因此使用 8443，不中断现有代理。80、3000 初检空闲，UFW inactive；没有改动已有 SSH/代理或生产数据。
- 初检 fwupd RSS 约 230MiB；对虚拟机执行可回退的 stop，未 disable，也不修改原服务配置。已安装 Ubuntu 仓库 Docker 29.1.3、Compose 2.40.3、Nginx 1.24.0 与 venv，另在专用 venv 安装 Certbot 5.8.0，日志留主机私有目录。未进行整机升级或重启。
- GitHub 仓库是 public；新增的 CI 镜像交付必须使用专用公钥加密，私钥不进入仓库、CI 或服务器。不把普通 Actions 访问控制当成私有发布权限。

## 本次实际结果

| 检查                             | 结果                      | 证明范围                                                                                            |
| -------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| Typecheck / lint / format / diff | PASS                      | 新增脚本及全仓静态检查                                                                              |
| 镜像交付边界测试                 | 17/17 PASS                | 真实加解密流、篡改密文/tag/来源拒绝、GCM 前不发布、输出不覆盖、失败清理；Docker producer 为模拟     |
| Node 24.14 全量单测              | 992 PASS / 4 SKIP，996 项 | 与 Docker/CI 相同主版本，97 文件通过                                                                |
| Certbot HTTP-01 dry-run          | PASS                      | 目标 IP 控制权、外部 80 验证                                                                        |
| 受信任 IP TLS                    | PASS                      | Let's Encrypt YE2，IP SAN；有效期至 2026-10-26；外部 curl 未跳过验证，TLS_VERIFY=0                  |
| HTTPS 应用健康                   | 未就绪                    | 当前 502，尚未加载应用镜像，不计为部署成功                                                          |
| 独立 PostgreSQL                  | PASS 启动                 | 实际 17.11 容器、独立命名卷、未发布数据库端口；后续迁移与应用角色初始化成功，公网业务路由已实际使用 |

第一次全量命令误用系统 Node 26.12，17 项 DOM localStorage 测试失败；改用项目 Docker/CI 的 Node 24.14 后完整 992/996 通过，未修改产品或跳过失败测试。首次续期演练与刚启用的 timer 并发，Certbot 拒绝锁；timer 本身退出 0。随后单独 dry-run + run-deploy-hooks 全部成功，nginx -t 与 reload 成功。timer 每小时并在开机后检查；没有强制重复签发。

## 进行中与验收边界

云端业务迁移/受限角色/Worker、网络业务链路与备份恢复仍在执行中。拟先用明确标注的 fixture 商品与 Mock AI；它们不能证明当前真实 Amazon 提取或真实模型质量。独立客户端会话不能当作跨物理设备；没有进行 Stripe 沙盒或真实交易。

上一版实际 CI 为提交 e5b3d3b 的 [run 39116884780](https://github.com/LogiX-D/ProductSpy/actions/runs/39116884780)，它通过静态、单元、真实受限 PG、构建、恢复、容器/Compose 与浏览器验证；不替代本次新增交付脚本或目标服务器的运行证据。

## 镜像与传输证据

提交 fdf16b9 的 [Linux CI run 39271145712](https://github.com/LogiX-D/ProductSpy/actions/runs/39271145712) 全部成功：981 PASS/15 SKIP（996），受限 PostgreSQL 67/67，MV3/工作台浏览器 3/3，逻辑恢复、默认生产构建、standalone、实际容器及原 Compose 全通过。实际 checkout c640249d49387bafa98e052947703260883a5858，tree 518bdaefe3ed40aad6745581b4a05eaa5ae03c57 与提交精确一致。

同一 job 已验证的两镜像加密包 385,557,827 字节，CI 只上传密文和 manifest，保留 1 天；Web/Worker 未压缩 size 分别 306,994,419 / 992,509,008 字节。服务器实际下载 ZIP 并验证 GitHub artifact digest，解包仅允许三个固定文件，密文与 manifest 的 SHA256SUMS 均通过。

本机网络下载在 180 秒超时（132,042,036/385,560,893 字节），未使用残缺文件；服务器改为直接下载同一密文，约 3MB/s。RSA 私钥仍仅在本机，用它解开本次随机 AES 密钥，通过已验证 SSH 的 stdin 将一次性 AES 密钥与 AAD 传给专用 Python 解密器，密钥不写 argv、磁盘或日志；GCM 成功前明文仅在 root 0600 临时文件，成功后独占生成归档。该方式只授权既定测试主机读取本次镜像，没有把 RSA 私钥交给主机。加载前仍需核对 source/tree 和两镜像 ID/revision。

## 应用首次上线及公网 API

两种镜像已实际加载，迁移与 productspy_app 初始化成功，Web/Worker 连接真实 PostgreSQL；默认 SaaS production 模式、每进程池 3、Worker 并发 1、AI_MODE=mock、支付关闭。HTTPS 健康实际返回 200，TLS 校验未关闭。初次测量：Web 68.37MiB、Worker 76.25MiB、DB 32.66MiB；主机 available 345MiB、swap 已用 101MiB、磁盘余 20GiB。这是一次空闲采样，不是容量或长期稳定性承诺。

实际公网 API 验收 17 项通过：双用户注册与 Secure/HttpOnly 会话、匿名拒绝、Free 50 商品/10 AI 默认权益、支付不可用、明确 fixture 商品保存、同幂等键无变更与不同 payload 409、商品/历史/任务/用量跨用户隔离、单次 Mock AI POST、持久任务成功、分析及历史保存、用量仅计一次、第二独立 cookie 登录读取同一云端结果。原始报告和测试凭据分开保存在本机忽略目录，凭据目录为当前用户专属 ACL。没有把独立会话称为跨物理设备。

首次加载校验因 Docker 29 containerd 的 manifest ID/Size 与 classic config ID/Size 不同而停止；没有继续启动未验证镜像。随后新增只读验证器，核对内容寻址 manifest SHA256、指向的 CI config digest、config 内容 SHA256、实际 rootfs diff IDs、架构和 revision，两镜像全通过后才迁移启动。6 项边界测试通过。文件大小差异只作存储诊断，不替代摘要身份。

本机浏览器工具提示 Work settings 禁用了 local browser use，因此未绕过设置或改用本机隐藏浏览器。专用 Linux CI 云端浏览器验收分别运行 fixture/live Amazon，目标限定获授权 HTTPS，强制 TLS 校验、Mock，禁止静默 fallback；新脚本静态及 2 项护栏测试通过，扩充后 Node 24 全量 994 PASS/4 SKIP（998）。该云端浏览器运行结果仍待实测。

## 后续验收修正

提交 46874f1 的 [完整 Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/39274458052) 已成功，包含新增 Python 身份边界测试。首次 [云端浏览器 run 39274446341](https://github.com/LogiX-D/ProductSpy/actions/runs/39274446341) 的 fixture/live 均在预检失败，Nginx 证明确有 200 状态请求。原因是验收脚本误将 Fetch Response.ok 布尔属性当成 Playwright APIResponse.ok() 方法；已修正并细分阶段/安全错误码诊断，未改应用或降低 TLS/Mock 要求。重跑结果另记。

真实云端额度测试已确认 Free 第 51 商品返回 403，第 11 个 AI 任务返回 429，累计用量 50 商品/10 AI。测试中第二次复用旧商品版本产生 409 失败，该已接受任务仍计入额度；没有重新提交它，而是保留失败，后续新的合成 Mock 额度任务读取最新版本后单次提交。无真实模型调用。合成 Pro 权益及恢复 Free 仍在单独验证，不视为 Stripe 付款。
