# AI 渠道管理页面布局修复：2026-10-27

用户截图显示管理表单标签与控件排列在同一行，文本域撑高、字段与高级选项错位。根因是管理页和商品分析/竞品中的渠道选择器复用了 `creation-*` 样式，而定义这些共享类的 CSS 只在内容创作和模板路由加载；直接打开管理地址时没有对应样式。管理页也缺少字段网格和卡片间距。

现由根布局加载既有共享样式，保留原设计；管理页使用局部 CSS Module 设置间距、默认渠道宽度和操作区。字段及高级兼容参数复用桌面双列、760px 以下单列网格，fieldset 保留禁用语义，网格放在内部容器以避开浏览器对 fieldset 匿名布局容器的差异。未更改认证、渠道保存、密钥、模型、额度或真实调用开关。

实际验证：

- 新增浏览器回归携带认证 Cookie 到全新 context，直接打开 `/settings/ai`，此前不访问内容或模板页；只创建不保存、无密钥的合成布局草稿。
- 旧构建负对照确实失败：1280px 卡片 padding 为 0；失败报告及 trace 保留在忽略目录 `.test-data/saas/admin-layout-20261027-negative`。
- 首次修复浏览器验证 2 PASS / 1 FAIL，fieldset 的计算网格列形式未符合两列断言。调整为内部 div 网格后保留原断言并通过；初次失败资料保留在 `.test-data/saas/admin-layout-20261027-initial-fix`。
- 修复后实际浏览器 3/3 通过：AI 管理/渠道选择及单次本地 HTTP stub、任务历史、完整工作台及跨账号隔离。冷路由覆盖 1280、375、320px，检查实际样式、两列/单列、所有可见控件边界、无横向溢出及保存按钮触达；三尺寸无密钥截图已人工查看。
- 本机 typecheck、lint、格式检查、默认扩展/Web 构建通过；单元/集成 1172 PASS / 5 SKIP。未覆盖或提交原有验收矩阵格式改动。

源码 `f9ca62809b591cf4c79e099fbe62370950c6b5ae` 的 [完整 Linux CI](https://github.com/LogiX-D/ProductSpy/actions/runs/40370568514) 实际 success：1161 PASS / 16 SKIP（1177 项），受限 PostgreSQL 110/110，浏览器/MV3 5/5；静态检查、逻辑恢复、默认构建、预览 ZIP、standalone、实际 Web/Worker 容器与原 Compose 通过。实际 checkout `e5365f05034085fd154254f83db69dc25118fd29`，tree `d6ef78320eb0813a2c564627042c8149f095c9d2` 与源码一致；同提交 push 运行取消，未将其当成测试通过。临时镜像导出标签已移除。

2026-10-27（Asia/Shanghai）已更新获授权测试站。核对 GitHub artifact 12672822283（386,643,576 字节）的 SHA-256、manifest 精确字节、源码/tree、接收者及 GCM 认证；RSA 私钥保留在本机。加载后通过 containerd manifest → CI config 与 rootfs 摘要独立确认两个镜像身份。实际加密备份后停 Web、排空任务、停 Worker，只替换镜像 revision；不执行迁移，不写 `.env.production`，不重设管理员或主密钥。

原 PostgreSQL 容器及 10-19 StartedAt 未变，用户、商品工作区、订阅、用量、任务、采集和平台渠道配置七表 count/checksum 前后完全一致，7 张 FORCE RLS 保留。运行环境 SHA-256 前后相同；Web/Worker 为新镜像、零重启/OOM，保持 Mock、真实支付关闭且未配置支付密钥。旧镜像与 selector 副本保留，可回退应用，不恢复覆盖业务数据。

公网实际 HTTPS 管理员登录、冷路由、1280/375/320px computed style/控件边界/无横向溢出/保存触达均通过并已查看截图。只使用未保存、无密钥的合成布局草稿，没有提交渠道配置、调用 AI 或请求外部提供商；前后配置仍为 revision 2、已保存渠道数 0。公开站前后报告及掩码截图在忽略目录 `.test-data/saas/deployment/admin-ui-browser-20261027-before` 和 `admin-ui-browser-20261027-after`，部署回执副本为 `admin-ui-service-update-recovered-20261027.json`。

保留部署观察失败：本机镜像加载与服务切换包装器各返回失败，未取得其异常原因证据；没有重跑加载或切换。随后只读检查证明镜像已加载且严格身份验证通过、服务器成功回执完整，继续以独立公网 UI 和只读服务/数据库/环境检查确认最终状态。未以包装器失败自动断言服务失败或重复变更，原失败输出和服务器成功回执分别保留。

本机业务浏览器测试为 HTTP/PGlite/合成账号/HTTP stub；Linux MV3 使用明确 fixture/Mock，公网本轮仅管理员布局检查。上述均不替代真实提供商、Amazon 新实页采集、物理跨设备或支付验收。真实 AI/Stripe 沙盒仍按用户安排保持待验，整体目标未宣称完成。
