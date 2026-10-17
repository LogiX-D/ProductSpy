# SaaS 本轮验证与交付记录

日期：2026-10-17（Asia/Shanghai）。实现提交 `18a4b8f`，开发分支 `codex/saas-migration`；原始基线 `b83027a` / `codex/baseline-v1-before-saas`。机器记录见 [JSON](saas-validation.json)。**本地实现与流程已通过下列检查，正式云端验收仍未完成。**

## 实际执行

| 验证                                             | 结果                             | 证明范围                                                                  |
| ------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------- |
| TypeScript / ESLint / Prettier / diff whitespace | PASS                             | 当前代码静态检查                                                          |
| `pnpm test`                                      | 80 files，811 PASS，3 SKIP / 814 | 原业务及 SaaS 单元/集成；3 项网络数据库专属测试由下一项单独执行           |
| `pnpm test:postgres`                             | 17/17 PASS                       | 实际 PostgreSQL 18.4、pg TCP 驱动、无 superuser/BYPASSRLS 应用角色        |
| `pnpm build`                                     | PASS                             | MV3 扩展及 Next.js standalone 生产构建                                    |
| `pnpm test:saas:e2e`                             | 2/2 PASS                         | 真实加载 MV3、真实本机 HTTP/数据库、Amazon HTML fixture、Mock AI          |
| 实时 Amazon 读取                                 | CAPTURED，HTTP 200               | 实际 MV3 从 B09B8V1LZ3 采集标题、9 图、6 卖点；无视频；未上传/分析        |
| PostgreSQL 服务重启                              | PASS                             | 测试商品在原数据库停止/启动后 checksum 一致                               |
| 停机物理副本恢复到独立实例                       | PASS                             | 55433 恢复实例数据 checksum 一致，另一用户 scope 返回 0 条                |
| legacy 导入 CLI                                  | PASS                             | 独立进程预览不写库，commit 归属目标账号，源 backup checksum 不变          |
| Stripe 官方 SDK 签名合同                         | 7/7 PASS                         | 离线签名、篡改、时间、test/live、客户/价格、去重/乱序；提供商 HTTP 为模拟 |

PostgreSQL 专属回归包括账户/持久会话、同 ASIN 跨用户隔离、详情/历史/备份授权、一次性授权码来源绑定、扩展最小权限、采集幂等、Free/Pro 和导入超限回滚、改密撤销、已认证排队请求的撤销竞态、PG 写锁与无阻塞读取、RLS 连接清理、持久队列、独立 Node worker 和 CLI。

独立 worker 测试在创建请求结束后启动另一个 Node 进程消费数据库队列并保存 Mock 分析；相同请求不重复预留额度。生产必须运行 worker，PGlite 开发使用单进程 runner。服务中断的 running 任务不自动重新收费调用；未执行的 queued 任务可以恢复消费。

浏览器链路 1：网页注册 → 授权实际 MV3 → fixture 页面真实提取 → HTTP 上传 → 商品库 → Mock 分析保存 → 第二隔离浏览器查看 → 另一账户不可读 → 真实浏览器断网/恢复队列。链路 2：注册 → 商品详情 → Mock 分析 → 内容计划与 Mock 生成 → 任务/套餐/账号 → 375px → 退出换账号无旧资料。

截图：

- [已保存的 Mock 分析](screenshots/saas/saved-mock-analysis.png)
- [扩展采集并登录](screenshots/saas/extension-captured.png)
- [375px 账号页](screenshots/saas/account-mobile.png)

截图仅为合成商品/测试账户，商品图用 fixture 占位；不是实际素材质量证明。实时 Amazon 原始 HTML、浏览器 profile、追踪与数据库均留在忽略的测试目录，不公开账户 token 或正文证据包。

## 失败记录与修复

- 迁移前旧基线 744/745，portable guide 拒绝版本点号文件名；最小修复后完整回归通过。
- 独立审查确认：改密未作废 pending code、导入商品自定义 ID 的 capture 重放、已认证请求等待期间发生撤销。均已修复并加入实际 route 回归。
- Stripe 读取最新状态移入用户锁，避免并行事件覆盖；媒体代理增加速率和进程并发限制。
- 首次启动 PGlite 缺父目录导致 readiness 503；数据库初始化现递归创建显式开发目录，嵌套空目录 SQL 回归通过。
- MV3 E2E 首轮因两个 Mock 标签触发严格选择器失败；修正选择器后通过，未把失败写成业务成功。
- 首次迁移脚本 top-level await/CJS、CLI 预览漏 options、测试重复 import 的 typecheck 失败均已修复并复跑相应命令。
- 独立队列任务在写结果前不提前暴露 succeeded，避免轮询误判；最终 UI E2E 已在队列路径通过。

## 尚未证明的要求

| 项目                             | 状态 / 需要的证据                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| HTTPS 云部署、正式 origin 扩展包 | 待用户指定并授权的预发布环境/域名；Dockerfile/Compose 具备准备，当前没有 Docker 运行证明 |
| 完整真实链路                     | 未完成：实时 Amazon 采集单独成功；完整链路仍为本机 fixture + Mock                        |
| 真实 AI                          | 未调用；需服务端凭据与明确测试预算/授权，另做内容质量核验                                |
| 跨物理设备                       | 未完成；同机独立浏览器只证明会话与服务端持久化                                           |
| Stripe 沙盒                      | 未交易；需真实 test account、price、secret、Webhook 投递与取消/失败场景                  |
| 真实交易                         | 未授权、未执行                                                                           |
| 真实私人数据迁移                 | 源目录未改动；应先指定真实 SaaS 归属账号，再预览/提交，不导入测试账号                    |
| 生产恢复/PITR                    | 仅临时本机物理恢复通过；托管备份、pg_dump/PITR、RPO/RTO 需目标环境演练                   |
| 公开运营资料                     | 需经营者/隐私联系人/保留期限、邮件核验/找回、账户注销；商店材料旧版已标历史              |
| 远端 CI                          | 查看开发 PR 当前 checks；本文件是推送前本机验收快照，不预先宣称 CI 成功                  |

未购买资源、未公开插件、未部署/修改生产、未合并主分支、未改动旧 Release。外部验收缺口仍在原始目标内，不能将本轮实现定义为全目标完成。
