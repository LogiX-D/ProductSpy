# 2026-10-18 Windows PostgreSQL 复验记录

本次从 `codex/saas-migration` 复查部署、CI、环境与恢复准备，并尝试在当前 Windows 环境重新运行真实 PostgreSQL 检查。**数据库已启动，但当前机器的 loopback 多轮通信异常，尚未完成本轮 PostgreSQL/standalone/恢复验收。** 旧 Linux CI 和旧 Windows 证据保留原日期与提交，不替代本轮结果。

## 审计结果

现有 SaaS 分支已经保留 Next.js/React/TypeScript、Amazon MV3 采集器和原业务 schema/UI；PostgreSQL JSONB、独立 Worker、受限角色/RLS、Docker 双 target、Compose、三类环境模板、旧数据导入与增强恢复脚本均已存在。原 Windows 启动器、DPAPI 和便携打包属于显式 legacy 回归边界。当前正式目标不依赖这些组件。

`.github/workflows/saas-ci.yml` 准备了静态检查、单元测试、受限 PostgreSQL、逻辑恢复、生产构建、扩展 ZIP、standalone、实际容器、原 Compose 和 MV3 E2E；没有自动生产部署、主分支合并或公开发布步骤。当前机器未发现 Docker、psql 或 PostgreSQL 服务，未读取任何现有数据库凭据。

## 独立临时工具

- 从 [PostgreSQL 官方 Windows 页](https://www.postgresql.org/download/windows/)指向的 [EDB 便携二进制页](https://www.enterprisedb.com/download-postgresql-binaries)取得 PostgreSQL 17.11-5 x64 ZIP。官方链接重定向到 `https://get.enterprisedb.com/postgresql/postgresql-17.11-5-windows-x64-binaries.zip`，381,531,864 bytes，下载指纹 SHA256 `80379b2c04d51c30225532e0ae04509899141e9957ed096fe749d7fd9df8f82f`。这是 HTTPS 来源与本地文件指纹，不是上游数字签名证明。
- 仅解压到 Git 忽略的 `.test-data/pg-runtime-2026-10-18/`，未安装系统服务、修改 PATH 或现有 PostgreSQL。
- 另下载 [Node.js 24.14.0 官方 Windows ZIP](https://nodejs.org/dist/v24.14.0/node-v24.14.0-win-x64.zip)，与 [官方 SHASUMS256](https://nodejs.org/dist/v24.14.0/SHASUMS256.txt)完全匹配：`313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66`。使用绝对路径调用，未安装或更改系统运行时。
- 首轮顺序下载较慢；分段下载出现一次 transport EOF，单独重试后严格核对每段长度、总长度并重新组合；最终 ZIP 目录可读、22,033 个条目，解压成功。失败未作为成功检查计数。

## 本轮实际结果

| 检查                                      | 结果与边界                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 验证器 ESLint / Prettier                  | 通过                                                                                                                                    |
| 清理护栏                                  | 5/5 通过；拒绝根目录、相邻目录、路径逃逸、其他 run marker、变更目标、相对路径和无效 run ID                                              |
| 临时 PG 初始化与启动                      | PostgreSQL 17.11 实际启动、随机 loopback 端口、`scram-sha-256`；日志显示 ready                                                          |
| bundled Node 24.19.0 → PG                 | 认证等待后 `read ECONNRESET`；服务器记录 authentication timeout，尚未执行迁移                                                           |
| 原生 psql → 同一临时 PG                   | 5 秒连接超时；不依赖 Node.js 客户端                                                                                                     |
| 官方 Node 24.14.0 → PG                    | 10 秒 `timeout expired`；尚未执行迁移                                                                                                   |
| 多轮 TCP echo                             | 两种 Node、`127.0.0.1` / `127.0.0.2` / `::1` 均只完成第一轮；第二轮与 FIN/end/close 未完成。每项使用新随机端口，结束主动销毁自身 socket |
| 两次幂等迁移、生产角色、PG 专属测试、恢复 | 验证器已准备顺序执行，但本轮被连接异常挡在迁移之前；均不能标记通过                                                                      |
| standalone                                | 未执行本轮真实 PG 验证；需成功生产构建及可用数据库连接                                                                                  |
| 清理                                      | 三轮均已停止自有临时库、删除合成口令和 cluster；结束复查无 postgres/pg_ctl 进程                                                         |

第一轮使用 `execFile` 启动 pg_ctl 时，daemon 继承的管道导致调用等待；按 marker 停库后得到 `ECONNREFUSED`，该轮为失败。验证器已改为启动时 `stdio: ignore`，pg_ctl readiness 在下一轮约 134 ms 返回；后两轮独立暴露实际认证/多轮通信异常。没有改为 trust 认证来绕过错误。

失败机器报告位于忽略的 `.test-data/saas/windows-postgres/`：

- `d6be0bee-b2c1-4f20-95fc-24b1ad5c9fa3/report.json`：首轮启动句柄诊断及清理。
- `3a10313c-7da6-47aa-836e-9f49215a7379/report.json`：Node 24.19.0，认证超时后 ECONNRESET。
- `569d52cc-75ae-4dd0-acf1-9ef9b3a2feff/report.json`：官方 Node 24.14.0，连接 timeout。

这些结果支持“当前机器的本机多轮通信异常”这一判断；尚未查明根因，不能据此确认代理、VPN、Windows 或某个具体组件有故障。未修改用户网络、代理、适配器、防火墙或系统加密设置。

## 可重复命令

先安装锁文件依赖。指定已解压的 PostgreSQL `bin` 绝对路径；验证器只创建自己的随机端口集群及合成管理员/应用角色，不连接现有数据库：

```powershell
node scripts/saas/verify-windows-postgres.mjs --pg-bin '<绝对路径>/pgsql/bin'
# 生产构建成功后，额外运行实际 standalone 检查：
node scripts/saas/verify-windows-postgres.mjs --pg-bin '<绝对路径>/pgsql/bin' --standalone
```

网络正常时，脚本依次执行生产迁移两次、受限 app 接受、管理员/BYPASSRLS/特权成员角色拒绝、PG 专属测试、增强逻辑恢复；可选执行 standalone。所有数据库 URL 和合成口令均从报告/日志脱敏。finally 先停库，再核对精确目录和本次 marker，才删除自有 cluster；保留可审阅报告。清理失败会将结果标为失败并保留目录。

当前仍缺公网 HTTPS、正式 Chrome origin/稳定版、真实 AI、跨物理设备、Stripe 沙盒及真实交易、生产备份/PITR 与运营资料的实际验收。本轮未购买资源、公开发布、修改生产或迁移私人用户数据。
