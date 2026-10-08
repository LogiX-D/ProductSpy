# Phase 9：真实环境验收与问题修复

验收日期：2026-10-08（Windows，Node.js 24，pnpm 10.32，Chrome for Testing 156）。在原有 monorepo、MV3 扩展、本地 JSON Repository / IndexedDB 缓存架构上修复，没有增加用户账号、收费或其他电商平台。

## 实际测试范围与方法

最终完整批次打开 **16 个真实商品 URL，全部 HTTP 200，16/16 成功采集**，含 13 个不同 ASIN 主样本。另在 Crocs 与 Hanes 页面通过正常可见颜色卡片点击切换到 2 个子变体，累计 **15 个实际商品 ASIN、5 个品类、4 个国家站**。重复国家站页面、同商品重测和服务重启检查不计为新商品。子变体单独验证 ASIN、价格、主图；以下完整字段成功率分母为 16 个主样本页面。

真实测试没有替换 Amazon HTML、网络响应或 DOM，不使用账号、代理轮换、验证码识别或保护绕过。点击 Chrome 扩展 action 时先激活商品标签，授予真实 `activeTab`；使用原始生产构建、原权限。页面稳定后独立记录 DOM、实际 Gallery 数据、截图与扩展结果，再比较字段。当前匿名配送上下文为台湾，多个国家站实际显示 TWD；这不是按站点货币猜测的结果。

只读批量复现：

```powershell
pnpm build
pnpm exec playwright install chromium
pnpm exec node scripts/amazon-acceptance.mjs --output .test-data/phase9-evidence/verified
pnpm exec node scripts/audit-amazon-evidence.mjs .test-data/phase9-evidence/verified
```

截图、原始 HTML、浏览器 profile 与完整商品草稿只保存在被 Git 忽略的 `.test-data/phase9-evidence/`，不提交。可公开的逐字段计数、摘要和 HTTP 结果见 [phase9-results.json](phase9-results.json)，不含 Cookie、配对码、连接令牌、Key、原始 HTML 或用户素材库。原始证据不会被 E2E 清理；E2E 输出目录独立为 `test-results/e2e/`。

## 每页结果

以下为最终批次的当时页面值，价格与评分数量会变化。所有行的 ASIN、标题、品牌、当前主图、图库、最高已暴露分辨率、卖点、评分及数量均通过独立比较，主图地址均 HTTP 200 / image MIME。`—` 表示页面没有可靠可见价格。视频列为媒体 URL 数，MP4/HLS 两种编码可能属于同一条视频，不能理解为不同视频数量。

| 品类 / 商品              | 国家站 | ASIN       | 可见价格   | 品牌                 | 图片 / 视频 URL / 卖点 | 评分 / 数量  |
| ------------------------ | ------ | ---------- | ---------- | -------------------- | ---------------------- | ------------ |
| 电子 / Echo Dot          | US     | B09B8V1LZ3 | —          | 亚马逊 Echo 和 Alexa | 9 / 0 / 6              | 4.7 / 200635 |
| 电子 / Logitech C920     | US     | B006JH8T3S | TWD2150.72 | Logitech             | 10 / 2 / 1             | 4.6 / 32792  |
| 美妆 / CeraVe 保湿霜     | US     | B00TTD9BRC | TWD606.36  | CeraVe               | 12 / 2 / 5             | 4.7 / 148820 |
| 美妆 / CeraVe 润肤霜     | US     | B07HQDXKW2 | —          | CeraVe               | 10 / 0 / 6             | 4.6 / 2604   |
| 美妆 / CeraVe PM 多件装  | US     | B018MR63HG | —          | CeraVe               | 4 / 0 / 2              | 4.0 / 1      |
| 鞋类 / Crocs Classic     | US     | B0014C5S7S | TWD1119.02 | Crocs                | 13 / 0 / 5             | 4.8 / 488910 |
| 家居 / upsimples 相框    | US     | B0BQR2BQYZ | TWD223.55  | upsimples            | 8 / 2 / 5              | 4.4 / 44119  |
| 家居 / Gorilla Grip 浴垫 | US     | B07FPQZG6V | TWD383.13  | Gorilla Grip         | 9 / 3 / 5              | 4.3 / 86549  |
| 家居 / Innqoo 蜡烛灯     | US     | B0DZFGTCLR | —          | Innqoo               | 7 / 2 / 6              | 4.6 / 6053   |
| 服装 / Hanes 套头衫      | US     | B00JUM2V4W | TWD550.39  | Hanes                | 8 / 0 / 5              | 4.5 / 172099 |
| 服装 / Hanes 拉链衫      | US     | B00JUM4DKC | TWD415.75  | Hanes                | 7 / 1 / 5              | 4.5 / 90074  |
| 厨房 / OXO 饼干勺        | US     | B0000CCY1E | TWD574.06  | OXO                  | 9 / 1 / 5              | 4.4 / 3518   |
| 厨房 / Capresso 磨豆机   | US     | B001QTVXCS | TWD3197.78 | Capresso             | 7 / 2 / 6              | 4.2 / 2762   |
| 电子 / Logitech C920     | DE     | B006JH8T3S | —          | Logitech             | 10 / 0 / 5             | 4.7 / 31940  |
| 厨房 / OXO 饼干勺        | UK     | B0000CCY1E | TWD1083.33 | OXO                  | 9 / 0 / 5              | 4.3 / 14653  |
| 电子 / Logitech C920     | JP     | B006JH8T3S | TWD2718.78 | Logitech             | 10 / 0 / 3             | 4.5 / 32074  |

Amazon 的 `acrCustomerReviewText` 在这些页面提供的是评分数量，数据模型沿用 `reviewCount`，不代表逐条文字评论数量。品牌字段可能是页面公开的品牌商店名称，例如 Echo 和 Alexa，不擅自改写成法人主体。

原生变体验证 **2/2 通过**：

| 商品         | 正常颜色点击后的 ASIN   | 价格变化                | 主图变化                  | 结果                                    |
| ------------ | ----------------------- | ----------------------- | ------------------------- | --------------------------------------- |
| Crocs        | B0014C5S7S → B0FPSBG9CY | TWD1119.02 → TWD1598.73 | 61SuPkDGYfL → 71+7WjYm2xL | 前后 ASIN / 价格 / 主图均匹配当前购买框 |
| Hanes 拉链衫 | B00JUM4DKC → B071FT2J6B | TWD415.75 → TWD415.75   | 71fm7+WAt4L → 71cXIb6DLZL | 前后 ASIN / 价格 / 主图均匹配当前购买框 |

没有购买操作、强制点击或直接改写 DOM。页面出现的不可配送提示不会被当作采集失败；价格仅反映当前页面显示，不承诺可购买。

## 各字段成功率与失败原因

区分「有数据时提取正确」和「页面本身提供数据的覆盖率」，不把缺失字段算作成功，也不把所有空视频当作确定没有视频。

| 字段                  | 实际核对结果                    | 覆盖率 / 边界                                                        |
| --------------------- | ------------------------------- | -------------------------------------------------------------------- |
| ASIN、标题、品牌      | 各 16/16，100%                  | 当前购买框和正文，非推荐商品 / SEO 标题                              |
| 当前价格              | 11/11 可见价格一致，100%        | 11/16，68.8%；5 页无可靠可见价格                                     |
| 货币                  | 11/11 明确标示 TWD 一致，100%   | 11/16，68.8%；不按 US / UK / JP 域名猜货币                           |
| 当前主图与图库        | 各 16/16，100%                  | 与当前 Gallery 对比，排除控件和其他颜色，按资源去重                  |
| 图片分辨率            | 16/16 取页面已暴露的最高候选    | 不是声称每张都有 1500px；无 hiRes 时使用最大 dynamic/main 候选       |
| 主图网络可访问性      | 16/16 HTTP 200，100%            | 验证主图，不代表已逐张下载全部图库                                   |
| Bullet Points         | 16/16，100%                     | 服装类使用 productFacts 正文；不是把空旧容器当作无卖点               |
| Rating / Review Count | 各 16/16，100%                  | 当前页面数值，含德语小数逗号 / 分隔符处理                            |
| 视频身份匹配          | 8/8 有绑定页面均通过            | 8/16，50%；其余没有可靠当前商品身份，保守留空                        |
| 视频 URL 网络检查     | 13/15 HEAD 返回 HTTP 200，86.7% | 2 个 TypeError 网络失败；HLS 原生播放及解码未完整验收                |
| 描述                  | 13/16 有文本，81.3%             | 3 页为无文本 / 图片型内容；内容来自商家正文或 A+，未验证商家宣传事实 |

视频身份核对读取 a-state 中 productAsin / pageAsin，优先明确 productAsin，不能用推荐播放器的页面上下文覆盖另一个商品的身份。只请求公开 URL，不绕过 DRM 或登录。网络 HEAD 成功不等同于完整播放成功，Capresso 的 HLS 响应还使用 text/plain MIME。Gorilla Grip 描述清除播放器 tooltip 的最后修复已用真实页面补测，核心字段仍一致。

初始候选中 7 个 URL 返回 Amazon 404：B096S5YCC6、B00Q7OAR6A、B0752H7J7V、B00006IBK4、B00JUM2VY6、B01ACAXECY、B01K9COQ70；无法从 404 判定是下架、无效链接还是地区原因，不计入成功商品。日本站曾出现 ERR_CONNECTION_CLOSED，后续正常公开访问成功。最终批次没有遇到验证码；并不声称验证码路径已做真实通过测试，更没有绕过。早期一次截图字体等待超时已作为测试工具异常记录并重采，该页最终完整采集成功。

## 发现与修复

1. **变体 ASIN 错配**：购买框当前 ASIN 优先于仍指向父商品的 URL；不再取任意推荐节点 data-asin。JSON-LD 仅选匹配商品或无身份的 fallback。
2. **标题 / 品牌 / 货币**：正文标题优先，剥离实际观察到的中德文商店包装；TWD、NT$、US$ 等明确标识解析。早期 US 页曾显示裸 `$67.25` / `$99.99`，未知 ISO 货币留空，增加回归，不冒充 USD。
3. **图片重复、遗漏与跨颜色污染**：安全解码 Amazon parseJSON 字面量；根据当前 ASIN / 主图选 Gallery；hiRes、large、thumb 即使资源 ID 不同也按同一记录去重；排除 Echo 360° 控件图。Logitech 曾混合 20 个分辨率 URL，修后 10 张；Crocs 曾混入约 100 张多颜色图，修后当前 Gallery 13 张。
4. **推荐视频污染**：相框多件装、Hanes 其他款式视频可能出现在全局 videos 数组。现在必须绑定当前 ASIN 或当前公开播放器；不可靠记录留空。
5. **描述污染**：读取重复 A+ 中的实际正文，去除品牌导航、比较表、脚本、播放器、翻页控件与隐藏视频提示，不用 SEO metadata 假充描述。
6. **本地 API 缺身份校验**：原接口接受任意 Chrome 扩展来源，已替换为一次性配对与会话认证，读、写、删除、媒体、AI 都要求身份。
7. **Next 生产会话 403**：真实 Host 与 Next 内部 request URL 各自严格允许 loopback，Origin 与 Cookie 会话绑定真实 Host，兼容 localhost / 127 内部重写。
8. **异常恢复**：401 自动重新建立 Web 会话，仅重试被拒绝的请求；并发 401 共享一次 bootstrap。断线、撤销连接与部分同步失败保留未同步商品，已同步记录不丢失，重复更新不生成新商品。
9. **验收工具问题**：先激活商品页再触发 action，避免测试工具漏授 activeTab；修复异步 waitForFunction 使用及 Next route announcer 选择器冲突；真实证据与 E2E 临时输出分离。
10. **货币重复显示**：真实 CeraVe 截图发现工作台将带 TWD 的价格再次添加 TWD 前缀，已修复并加入回归。解析值保持页面原始价格。

## 安全检查

| 项目               | 实际结果                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 扩展来源与写入身份 | 128-bit 一次性配对码，120 秒；256-bit 令牌绑定真实扩展 Origin，服务端仅存 SHA256；可撤销与重配                                   |
| Web 读写身份       | 随机 HttpOnly、SameSite=Strict Cookie，12 小时；会话绑定真实 Host，同源 bootstrap，限制新会话和配对失败尝试                      |
| CORS / CSRF        | 精确本机 Host / Origin，JSON、客户端标头、Sec-Fetch-Site 校验；仅配对扩展获得受保护接口 CORS；冷启动重新载入持久化 Origin        |
| 本地数据保护       | 原子替换与损坏保护；POSIX 目录0700 / 文件0600，Windows继承 ACL；JSON 未加密，非 OS 用户隔离                                      |
| 媒体下载           | 精确 HTTPS Amazon CDN 白名单，禁重定向，MIME / 文件签名 / 单图10MiB / ZIP80MiB，已认证接口                                       |
| AI Key             | 只在服务端环境变量；扩展、浏览器包、公共状态接口不包含 Key                                                                       |
| MV3 / 权限         | activeTab、scripting、storage 与本机 host access；没有 Amazon 全站 host permission、远程代码或 eval；令牌存储限 trusted contexts |
| 公开说明           | 增加 PRIVACY.md、Popup 采集 / 本机保存 / AI 传输提示、真实 AI 操作前提示、图标与最低 Chrome120 安装版本                          |
| Git 敏感文件       | .env.local、用户素材库、配对凭据、真实 HTML / profile / 测试数据全部忽略，未跟踪                                                 |
| 依赖               | pnpm audit --prod：115 个生产依赖，0 个已报告漏洞（本次检查结果，不是永久保证）                                                  |

该方案保护浏览器来源边界，不能抵御已经控制本机同用户进程、读取磁盘或伪造 HTTP 的程序，也不能隔离同 host 的其他本机服务。不适合直接部署公网。

## 完整业务与自动化结果

真实 CeraVe B00TTD9BRC 完成 Amazon → 生产扩展 → UI 配对 → 保存 → 工作台详情 → Mock AI → 页面刷新。随后实际停止并重启 Next 进程，复用原扩展 profile，无重新配对即可保存并再次分析；文件内仍只有 1 件商品，ID / createdAt 不变，updatedAt 更新，分析存在。测试使用独立 `.test-data/phase9-live`，没有向用户默认素材库注入验收数据。

自动化 E2E 使用明确标注的 Amazon HTML fixtures 和网络故障注入，覆盖首次 activeTab 授权、UI 配对、保存、去重更新、搜索 / 视图、详情、单图 / ZIP、完整 Mock、复制、刷新、旧分析在 AI 503 后保持、IndexedDB 离线读取、未同步队列、部分成功、重新连接、删除以及来源攻击。这些 fixture 结果不计入真实商品数量或实页成功率。

| 必须执行的命令    | 结果                                             |
| ----------------- | ------------------------------------------------ |
| pnpm install      | 通过，lockfile 已是最新                          |
| pnpm typecheck    | 通过，strict TypeScript                          |
| pnpm lint         | 通过，0 errors / warnings                        |
| pnpm format:check | 通过                                             |
| pnpm test         | 16 文件，188 项通过；其中44项独立 extractor 测试 |
| pnpm build        | Extension Vite 与 Next.js production build 通过  |
| pnpm test:e2e     | 4/4 通过，完整生产扩展业务与安全浏览器请求       |

真实 OpenAI-compatible Provider 只通过本地 HTTP stub 验证成功响应、schema、超时、错误与保存合约；没有使用真实 Key 调用收费模型。Mock 完整流程已实际执行，不能将此描述为真实模型质量验收。

## 尚未解决与上架判断

技术 MVP 与本阶段修复已通过所列检查，**尚未达到可直接提交 Chrome Web Store 的完整准备标准**。

- 尚缺常用 Chrome 稳定版的人工加载、配对、真实页面和交互验收；macOS/Linux、其余国家站、最低 Chrome120 本身未逐版验证。
- 5 页价格缺失与不可靠视频受 Amazon 当前配送上下文 / 页面机制限制。2 个视频 URL 网络检查失败，HLS 全量播放、每张图库下载和动态视频用户交互覆盖仍待补。
- 商品详情由商家提供，文本和规格可能不一致；描述、宣传效果与 AI 推断需要人工判断。
- 商店专用真实截图、440×280 宣传图、开发者 Dashboard / 两步验证、公开隐私链接和权限 / 数据披露表单、审核可复现说明尚须发布前完成；本阶段未上传商店、未承诺审核通过。

详情见 [Chrome Web Store 准备说明](chrome-web-store.md) 与 [隐私说明](../PRIVACY.md)。准备说明引用并核对了 2026 年生效的官方数据单一用途与显著披露要求。
