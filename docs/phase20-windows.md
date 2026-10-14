# Phase 20：Windows 候选版启动器检查

目标版本 `1.0.0-rc.1`，基于 `08eefad297816b6b6b2cb236ba40ef7951960000` 的便携架构。继续使用 Windows PowerShell 5.1、包内 Node.js 和 Next.js standalone；没有引入安装器、Electron、管理员提权或新的后台服务。

## 可复现问题及处理

### PS20-WIN-001：损坏停止控制文件会阻断孤儿服务清理

原 `run-server.cjs` 在同一 `try` 中先解析 `stop-request.json`，再检查启动器父进程。损坏或未写完的 JSON 每次都会提前进入 `catch`，因此父进程已经退出时也不会触发服务清理。

修复前用真实 Node 子进程、无网络端口的服务桩复现：控制文件为损坏 JSON、父 PID 不存在，4 秒期限内子进程仍存活。修复后独立处理文件解析和父进程检查；同一测试进入 SIGTERM 清理并正常退出。活着的父进程、其他 `launchId` 以及临时损坏的 JSON 不会误停当前服务。

### PS20-WIN-002：退出控制目录不可写时必须仍清理本次服务

原退出代码先写停止请求；写入异常会直接离开清理函数。现在捕获控制目录写入失败，输出清晰的停止警告，并仅终止本次启动时创建的进程对象。正常退出继续走已有 SIGTERM；控制目录不可写或超过正常退出期限时，才使用本进程对象的停止后备措施，不查找或终止其他监听程序。

真实子进程回归验证控制文件不能写入时，本次服务仍退出，警告明确说明范围。后备强制停止不能冒充正常 SIGTERM；业务文件原子写入和恢复保护仍由原有仓库与备份机制负责。

### 目录写入预检

启动前对运行控制、用户根目录、商品资料、AI 设置和日志目录进行实际 `CreateNew → 写入 → Flush → 删除` 探测。已存在的目录不代表可写；路径被文件占用时也明确拒绝。提示包含对应目录、写入权限和磁盘空间排查方法，说明程序不会自动提权或改权限。

测试在独立临时目录设置当前用户的真实写入拒绝 ACL，验证失败提示、现有资料字节不变、原 DACL 恢复及探测文件清理。**这是测试夹具权限设置；ProductSpy 本身不会修改用户目录 ACL。**

## 已实际执行的源码回归

```text
pnpm exec vitest run scripts/windows-launcher.test.mjs apps/web/src/lib/ai/windows-settings.test.ts
pnpm exec eslint scripts/windows-launcher.test.mjs scripts/test-portable.mjs packaging/windows/launcher/run-server.cjs --max-warnings=0
```

2026-10-14 本机 Windows x64 / 系统 Windows PowerShell 5.1 上：两文件 **9 项通过**，包括 5 项启动器回归、4 项已有 AI 设置安全与旧版 DPAPI 兼容回归。没有占用 3000 端口，没有调用真实 AI，没有读取个人商品库。

修复前后的实际 JSON 日志位于忽略的 `.test-data/phase20/windows-launcher-before.json`、`windows-launcher-after.json`。修复前缺少新写入检查函数的失败只作为开发回归记录，不能冒充已发现的用户数据丢失。

## 最终便携包回归范围

`scripts/test-portable.mjs` 保留已有十项便携生命周期检查，并增加：

- 不完整包在启动前明确提示完整解压。
- 用户数据路径被文件占用时拒绝启动，原文件字节不变。
- 真实拒绝写入 ACL 在服务启动前被识别，不提权，不改已有资料。
- 原孤儿服务回归加入损坏 `stop-request.json`，继续核对重启后完整分析和商品数据。

这些检查需由完整候选包实际执行。最终结果、日志、包哈希和升级证据以 [Phase 20 验收报告](phase20-validation.md)为准，源码级通过不能替代包级通过。

首次包级回归已通过包清单、解压错误、文件占用及拒绝写入检测，随后测试夹具的 ACL 恢复断言失败。诊断确认 Windows 的 `.NET SetAccessControl` 将本机 E: 目录原 `D:` 标志规范化为 `D:AI`；原权限规则已经恢复，不能将此误报为产品数据或权限丢失。测试辅助现在根据原描述符恢复：已有 AI 标志使用原 .NET 路径，原无 AI 标志使用不传播的 DACL-only Windows API；保留原完整 SDDL 的严格相等断言，没有删除测试或忽略权限标志。

直接提取实际测试辅助，在 E: 工作区和 C: 系统临时目录分别执行真实拒绝写入、原数据字节校验、严格恢复和恢复后写入，两种原描述符均通过。初次失败日志保留，详情在忽略的 `.test-data/phase20/portable-acl-regression/report.json`；曾使用的独立探测目录也已按保存的原描述符恢复，保留证据，没有操作个人数据目录。这是测试辅助修复，不改变候选包内容。

## 桌面证据与待验收

真实 Windows Forms 窗口、按钮、正常关闭、原生选择目录、高 DPI 和 SmartScreen 以最终桌面实际证据逐项更新；没有证据的项目保持待验收。无端口 Node 服务桩不是 Windows GUI 人工验收，也不是正式 Chrome 安装验收。

产品默认仍使用同一 Windows 用户的持久目录 `%LOCALAPPDATA%\ProductSpy`，软件解压目录仍与资料分离。DPAPI 只保护当前用户的 AI 设置；普通商品 JSON 不是应用级加密文件。程序更新不会主动清空资料，跨版本完整性仍必须通过实际旧包升级测试。本阶段测试均显式指定隔离的 `.test-data` 用户目录，不读取个人默认商品库或真实 AI 设置。

本阶段尝试启动可见 WinForms 窗口时被自动审批拒绝（`blocked by policy`，未提供细分原因）。没有通过其他命令绕过，GUI按钮/鼠标双击等保持待人工；实际包的无界面生命周期为独立测试，不冒充 GUI 通过。见 [桌面状态](phase20-desktop-evidence.json)。
