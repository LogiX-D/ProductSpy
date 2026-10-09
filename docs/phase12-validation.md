# Phase 12：AI 分析能力升级

验收日期：2026-10-09，版本 **0.4.0**。在 v0.3.0 的 `1335832` 上继续开发，保留 Next.js、Manifest V3、安全配对、Repository、本机 JSON / IndexedDB 和 Windows 便携分发。没有新增账号、收费、云端数据库或其他平台，也没有提交 Chrome Web Store。

## 实际完成

- Provider 支持 Chat Completions 根地址或完整地址、JSON object / strict schema / 文本 JSON、两种 Token 参数及可选温度。默认输出上限 8192、超时 60 秒且最多 120 秒。拒答、截断、响应大小、结构缺失、限流与超时均有明确错误，不自动换参数或重复收费调用。
- Windows 原启动器增加兼容配置，API 地址、模型和 Key 继续由本机服务端使用。设置采用 DPAPI CurrentUser；实际 PowerShell 测试验证旧配置解密与新字段，不把 Key 放入浏览器或扩展。
- 分析页加入四市场、三语言、三平台、四风格、三时长、营销目标和自定义要求；本浏览器可保存偏好。Mock 与真实服务明确区分，真实分析每次单独授权，扩展凭据不能发起收费分析。
- 事实清单由已采集字段生成，商家卖点标作页面宣称；受众、痛点和角度属于推断。没有评论正文，不声称分析了评论。默认不发送媒体文件或媒体 URL。
- 指定字段重生成保留未选内容，历史保存完整生成、人工编辑与恢复结果；比较版本、恢复新增版本、单项 / 整篇复制、Markdown / TXT 导出均可运行。局部更新明确提示参数和来源仅适用本次部分。
- 旧分析首次变动时才归档，读取 v0.3.0 数据不会重写文件。每商品最多 50 版本，满时在收费请求之前拒绝，不删除历史。CAS 冲突保护和标签页草稿保留。
- 请求前持久化编号与用量预留；同编号重放不再次调用模型。请求丢响应后可「检查上次请求结果」，仅本地读取，展示商品当前结果并保留后续人工编辑。失败和中断费用不猜为免费。
- 真实请求最多并发 2、每天 UTC 默认最多 50，失败也计入；429 冷却。Token 按服务商实际返回记录，只有完整自填单价和 Token 才估算 USD。独立用量文件不保存 Key、接口地址、商品正文、媒体 URL 或自定义要求原文。

## 自动化结果

结果汇总与产物 SHA-256 见 [phase12-results.json](phase12-results.json)。所有测试使用独立目录；没有向默认用户素材库写入测试数据。

| 检查                              | 结果                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| pnpm install                      | 通过；新增 Web 直接 zod 依赖，锁文件保存                           |
| pnpm typecheck                    | 通过，共享类型 / Extension / Web / E2E strict                      |
| pnpm lint                         | 通过，0 警告                                                       |
| pnpm format:check                 | 通过                                                               |
| pnpm test                         | 36 文件、385 项通过；保留原有回归                                  |
| pnpm test:ai-quality              | 73 测试通过：72 案例 × 7 护栏 + 1 对抗测试                         |
| pnpm build                        | Extension Vite、Next.js 生产构建通过                               |
| pnpm test:e2e                     | 10 项通过，含原 7 项和新 3 项                                      |
| pnpm test:portable                | 9 项通过，实际 Windows PowerShell / 内置 Node                      |
| pnpm test:upgrade                 | 9 项通过，实际 0.3.0 → 0.4.0 两套便携包                            |
| node scripts/validate-release.mjs | 4 项通过：实际 ZIP 路径、CRC32、逐文件 SHA-256、权限及敏感文件检查 |

新的 E2E 覆盖偏好保存、参数生成、人工摘要保留、日文开场局部生成、版本比较恢复、Markdown 下载、收费授权取消 / 确认，以及已保存响应丢失后跨刷新检查并保留另一标签页的新修改。收费界面测试为受控 Stub，不调用外部模型。

升级检查先用冻结的 0.3.0 便携包保存完整商品和 Mock 分析，再停止旧服务并启动 0.4.0。确认商品字段、ID、时间、媒体、分析与原文件完全保留；随后执行去重更新、旧分析归档、人工编辑、日文局部生成、同编号重放、版本恢复及重启后的完整历史保留。

## 实际运行截图

截图使用实际生产便携工作台与原权限扩展，来源和 SHA-256 在 [screenshots/phase12/provenance.json](screenshots/phase12/provenance.json)。公开截图不含配对码、令牌、Cookie 或 Key；浏览器 profile、用户文件和私有日志仅保留在 Git 忽略目录。

本轮正常打开 [CeraVe B00TTD9BRC](https://www.amazon.com/dp/B00TTD9BRC)，实际商品数量为 **1 个美妆商品**。两次重测同一 ASIN 不计作两个商品；终轮价格 TWD606.36 / TWD，12 张图片、5 条卖点、0 个可可靠归属的视频 URL。前轮曾获取 2 个视频 URL，说明动态页面媒体可能波动，终轮如实保留无视频状态。没有替换 HTML / DOM / 网络响应，没有绕过验证码或登录保护。浏览器为 Chrome for Testing 156.0.8078.4，分析全部使用本机 Mock。

| 截图                                                          | 内容                       |
| ------------------------------------------------------------- | -------------------------- |
| [插件](screenshots/phase12/01-popup.png)                      | 实际采集与保存             |
| [分析页](screenshots/phase12/07-analysis.png)                 | 明确 Mock 的运行结果       |
| [参数设置](screenshots/phase12/11-analysis-options.png)       | 市场、语言、平台及局部生成 |
| [移动设置](screenshots/phase12/12-options-mobile.png)         | 375px 页面                 |
| [局部开场](screenshots/phase12/13-partial-hooks.png)          | 日文开场，原人工摘要保留   |
| [事实与推断](screenshots/phase12/14-facts-and-inferences.png) | 页面文字与不确定性         |
| [版本比较](screenshots/phase12/15-version-comparison.png)     | 原人工版本与局部生成差异   |
| [用量](screenshots/phase12/16-local-usage.png)                | 本机请求记录，0 次真实 AI  |

## 已修复的验收问题

1. 已保存分析被重新生成覆盖：改为完整历史归档、仅合并所选字段和 CAS 保护；未保存草稿保持独立。
2. 旧 Provider 固定 JSON / max_tokens / 温度：新增显式兼容选项，拒绝不支持的输出并提示手动调整，无自动付费回退。
3. UI 先超时而服务端仍长期请求：服务端上限统一 120 秒，客户端等待上限 130 秒。
4. 丢失响应后新 UUID 无法利用幂等：准备阶段固定编号，跨刷新保留未确认编号，检查仅访问本机，显示当前已保存分析。
5. 局部生成把整篇标成新市场 / 语言：明确显示生成范围，未选部分来源可能不同。
6. 持久化 started 状态被误称「进行中」：改为「已发起 / 完成状态未确认」，中断费用显示未知。
7. 旧 E2E 的 Mock 文案定位与历史列表重名：定位当前分析标题中的来源徽标，保留原断言内容；丢响应 Stub 用已认证本机测试客户端转发，保留 Origin / CSRF 校验。
8. 打包与加载扩展同时执行会改写 dist：最终验收改为串行，重新完整执行 E2E。
9. 新用量文件若被生产跟踪可能误入包：打包复制与实际 ZIP 检查均排除 `analysis-usage.json`；新 AI 指南随便携包提供。
10. 实际截图发现分区标题被固定复制栏遮住：截图定位留出 100px 间距后重新拍摄。应用分区导航原有 `scroll-margin-top` 保留；未用图像编辑伪造界面。

## 仍未验证与限制

- 本轮 **0 次真实收费模型调用**。72 个合成 Mock 案例的 504 项检查不代表真实模型准确率或商业效果。没有授权 Key 与明确预算，真实模型自然度、营销价值、自定义语义和延迟 / 费用仍未验收，详见 [AI 质量报告](phase12-ai-quality.md)。
- 当前机器未发现正式 Google Chrome 稳定版；实际浏览器使用 Chrome for Testing。正式 Chrome、Windows WinForms 设置窗口的鼠标操作、高 DPI、全新非开发者电脑、未签名程序提示仍需人工验收。
- 并发 / 每日请求及 Token 上限不是美元硬预算，未知费用也不计为 0；需要服务商消费限制。生成失败 / 超时仍可能收费。
- 局部生成当前请求完整输出，只合并所选字段，不保证节省 Token。50 版本上限不提供历史删除管理，满时需导出并保留文件，当前不能继续新增版本。
- Mock 自定义要求仅作核查备注；不是语义执行模型。事实分类与 schema 无法保证真实模型没有幻觉，发布前仍需人工核实全部正文。
- 用户目录与普通浏览器存储不是完整 OS 隔离；商品、历史和偏好未做应用级加密。DPAPI 只保护启动器配置。
- 国家站、变体、视频、验证码等采集限制沿用原报告；本阶段不重新统计 Phase 9 实页成功率，不把旧截图和 Mock 当作当前真实验证。

## 复现

先停止自己的 3000 服务，按顺序执行：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:ai-quality
pnpm build
pnpm test:e2e
node scripts/package-windows.mjs
pnpm test:portable
pnpm test:upgrade --from artifacts/ProductSpy-0.3.0-windows-x64 --to artifacts/ProductSpy-0.4.0-windows-x64
node scripts/validate-release.mjs
pnpm capture:experience
```

升级测试需保留之前的完整 0.3.0 产物；不以同版本换目录代替升级。所有脚本只停止自己确认拥有的服务，不结束其他监听进程。源码启动、插件安装、AI 配置及普通用户操作见 [README](../README.md)、[Windows 指南](windows-guide.md)与 [AI 指南](ai-provider-guide.md)。
