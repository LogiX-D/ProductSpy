# 版本更新记录

## SaaS 迁移开发分支 — 未发布

正式架构为 Chrome MV3 + 在线 SaaS + PostgreSQL 云端后端，复用原采集器、Next.js/React 与业务模型。已有账号、租户/RLS、持久任务与 Worker、Free/Pro、订阅接口、导入恢复及容器准备；旧 v1.0.0 与 Windows 兼容源码保留在回退基线。2026-10-18 复审补上扩展成功同步副本清理、任务限流后安全轮询、生产连接权限保护及专用事务迁移。真实云端、真 AI、物理跨设备与支付沙盒/真实交易分别保持待验收，详见 [SaaS 验证记录](docs/saas-validation.md)。以下版本记录为历史本地发行证据。

## 1.0.0 — 正式交付草稿

基于 rc.2，无新增业务模块。2026-10-16 维护者在原故障电脑、正式 Google Chrome 中确认工具栏 Popup 正常，`PAIRING-SMALL-WINDOW` 记为 fixed + manually verified；仅 C07 通过，其余 52 项人工验收保留 pending。应用版本 1.0.0，Chrome 数字版本 1.0.0.3 高于 rc.2，显示名 1.0.0。重新执行工程回归、旧包升级和独立打包，保留所有候选包及草稿。实际结果见 [正式交付报告](docs/stable-release-validation.md)。Release 不公开、不提交 Chrome Web Store，真实付费 AI 质量仍待授权验收。

## 1.0.0-rc.2 — Chrome action Popup P1 Hotfix

维护者已在正式 Chrome 工具栏复现小空白窗口。独立 CFT 的实际 action Popup 与逐项 CSS 干预确认：`max-width: 100vw` 和 `100dvh` 令根尺寸反馈到 Popup 自动尺寸计算，普通标签页测试掩盖了问题。改用内容确定的固定根尺寸、内部纵向滚动；同意设置读写增加有界等待和卸载清理，失败时保持禁止采集。Chrome 数字版本递增为 `1.0.0.2`。保留 rc.1 原包、用户资料与安全权限；回归及实际尺寸见 [Hotfix 报告](docs/rc2-popup-hotfix.md)。10-15 交付时为 fixed, pending native Chrome verification；10-16 收到维护者同条件人工确认后仅本项更新为 fixed + manually verified，未改写旧包及原工程证据。

## 1.0.0-rc.1 — Phase 21 冻结验收（原二进制不变）

新增候选包与远程草稿的重复核对、隔离便携包回归和实际界面证据、53 项人工操作单、六品类真实 AI 授权与评分准备。新增 Amazon 实页结果保留访问超时、视频快照差异和人工待验收状态；没有用 Mock 代替真实模型质量。详见 [Phase 21](docs/phase21-validation.md)。没有新增业务模块、重打同版本包或公开 Release。

## 1.0.0-rc.1 — Phase 20

正式发布候选版，保持本地优先、现有业务架构与安全配对。Chrome 数字版本和候选版名称分别校验，Windows 包补齐离线安装、AI 与完整备份指南。完整工作流、备份恢复、历史保留、Stub 真实接口及旧便携程序升级追加验收，实际修复和结果见 [Phase 20](docs/phase20-validation.md)。Release 保持草稿；工程通过与真实环境/正式公开发布分开判断。

## 0.8.0 — Phase 19

商品到素材/竞品/模板/内容的跨模块来源检查，完整业务备份与事务恢复，历史归档和明确清理。修复备份暂存崩溃窗口、内部独占锁校验、商品分析引用遗漏、历史反馈和素材来源布局。见 [验收记录](docs/phase19-validation.md)。

## 0.7.0 — Phase 18

用户 AI 模板、变量校验与版本管理；营销内容生产、人工草稿保护、多版本、文本 ZIP 导出。见 [验收记录](docs/phase18-validation.md)。

## 0.6.0 — Phase 17

素材元数据、质量来源、URL/内容哈希去重和允许的下载；竞品对比方案、快照与 AI 对比。见 [验收记录](docs/phase17-validation.md)。

## 0.5.2 — Phase 16

真实页面与质量复核、安全及稳定性修复。真实付费 AI 和外部用户反馈没有授权/证据时仍为待验收。见 [验收记录](docs/phase16-validation.md)。

## 0.5.1 — Phase 14

封闭测试材料、工程与便携检查，不公开发布。见 [验收记录](docs/phase14-validation.md)。

## 0.5.0 — Phase 13

分组、标签、组合筛选、批量操作、导入导出及备份；保留旧 AI 与历史。见 [验收记录](docs/phase13-validation.md)。

## 0.4.0 — Phase 12

AI 参数、Provider 兼容选项、逐次授权、幂等与用量、人工编辑及生成历史。见 [验收记录](docs/phase12-validation.md)。

## 0.3.0 — Phase 11

统一中文界面、可复制编辑的分析、草稿和交互反馈。见 [验收记录](docs/phase11-validation.md)。

## 0.2.0 — Phase 10

内置运行时的 Windows x64 便携包、启动器、独立用户目录和 DPAPI 设置；商店准备材料不代表正式提交。见 [验收记录](docs/phase10-validation.md)。

## 初始 MVP 与 Phase 9

Amazon MV3 采集、本机 bridge、商品工作台、Mock/兼容 AI；真实页面与安全回归。见 [验收记录](docs/phase9-validation.md)。历史报告保留各阶段原始测试条件，不追溯改成最新版本成绩。
