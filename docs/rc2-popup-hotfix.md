# ProductSpy 1.0.0-rc.2：工具栏 Popup P1 Hotfix

日期：2026-10-15（Asia/Shanghai）。本次只修复插件入口尺寸和相关初始化兜底，不增加业务模块。rc.1 包与远程附件保持不变，rc.2 使用新的版本、文件和校验值。

**PAIRING-SMALL-WINDOW：P1，`fixed + manually verified`。** 维护者于 2026-10-16 明确提交同机、正式 Google Chrome、rc.2 修复后通过声明。2026-10-15 工程交付时的状态为 `fixed, pending native Chrome verification`；本次仅追加这项人工确认，不改写下方原始工程数据、旧包、Release 附件或其他人工用例。

## 维护者同条件人工确认（2026-10-16）

证据来源：维护者在当前项目会话中的直接文字声明。ProductSpy 版本为 **v1.0.0-rc.2**；在之前出现小黑框的**同一台电脑、正式 Google Chrome** 中，点击工具栏 ProductSpy 后，Popup 正常显示，不再出现小黑框或极小窗口，可正常查看和操作，维护者明确确认问题修复。

本项更新为 **fixed + manually verified**；[人工结果表](phase21/manual-results.csv)仅 C07 从 pending 更新为 pass，53 项中现为 **1 pass、52 pending**。C02 还包括滚动验收，未因基本显示通过而自动关闭。首次同意、Amazon 识别/保存、在线/离线、配对、重启、内部滚动及逐档 Windows DPI 等其他场景保持原状态。

未提供的细节：Chrome 完整版本、Windows build、系统显示缩放、Chrome 页面缩放、Popup 实测外框宽高、滚动/闪烁的专项结果及新增截图。不推算或补造这些信息，也不把 CFT 截图改称维护者截图。本次会话声明足以关闭已报告的小黑框缺陷，但不代表所有 Chrome/Windows 人工测试或真实 AI 质量通过。

维护者同时授权以 rc.2 为基础制作 **v1.0.0 的独立包和 GitHub Release 草稿**；这不授权公开 Release 或提交 Chrome Web Store，不改变仍未执行人工项目的 pending 状态。正式包工程回归结果应另行记录，不能预先沿用 rc.2 成绩作为新版通过记录。

## 根因与受控证据

冻结 rc.1 的 `body` 同时设置 `width:400px; max-width:100vw; height:min(600px,100dvh)`。真正 action Popup 的内容尺寸参与宿主自动尺寸计算，根宽高又依赖当前 viewport，形成尺寸反馈。Chrome 的 action Popup 会按内容自动调整尺寸，见 [Chrome 官方 action 文档](https://developer.chrome.com/docs/extensions/reference/api/action#popup)。

隔离 Chrome for Testing 156.0.8078.4 的 headed 与 headless 都复现。使用 CDP 调用 action，识别新创建的 Popup target，并用 `chrome.extension.getViews({type:'popup'})` 确认是 Popup；没有给这个 target 设置 viewport。React 已挂载、生产 CSS 已加载、JS 异常为 0。

| rc.1 受控条件                   | 实际 action 内容区（CSS px） |
| ------------------------------- | ---------------------------- |
| 原样                            | 25×25                        |
| 仅取消 `body max-width:100vw`   | 400×25                       |
| 仅把 `body height` 换成 `600px` | 25×600                       |
| 两者修正，并明确根节点固有宽度  | 400×600                      |

同一冻结扩展在普通 `popup.html` 标签页中，body/root/shell 原本为 400×600；该标签页有预先确定的 viewport，掩盖了反馈问题。原小 action 中 header 约 32×91，背景为深色且超过 25×25 可视区；真实截图与被裁切的 header 相符。不能把这组 CFT CSS 尺寸直接等同于历史裁剪截图的 55×58 物理像素，后者仍缺完整缩放与窗口边框数据。

[完整尺寸/计算样式/DOM 与文件哈希证据](rc2-popup-diagnostics.json)包含 html/body/#root/.popup-shell、document.clientWidth/Height、body.getBoundingClientRect、CSS 加载和 React 挂载结果。截图均为实际 action target 截取，未重绘：

| rc.1 实际小框（CFT）                                   | rc.2 最终包实际 Popup（CFT）                                | 合成长内容内部滚动                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| [原图](screenshots/rc2-popup/rc1-action-collapsed.png) | [原图](screenshots/rc2-popup/rc2-final-artifact-action.png) | [原图](screenshots/rc2-popup/rc2-final-artifact-synthetic-scrolled.png) |

## 修复与高度选择

- html/body/#root/.popup-shell 固定 400px 宽、最小宽 400px；不使用 viewport 单位、百分比、变量或基于 viewport 的根尺寸运算。
- 最终高度为 **420px**，由实测决定。原拟 600px 在默认 headless 800×600 屏幕中被夹限；模拟 DPR 2 的 headed CFT 也发现 600/480/440px 遮住底部按钮，420px 能完整显示 footer。没有通过扩大 action viewport、隐藏失败或降低尺寸断言来掩盖夹限。
- header/footer 不收缩；main 使用 `flex:1; min-height:0; min-width:0; overflow-y:auto`，长无空格内容可折行，不扩大外框，无横向溢出。内容多时在 main 内滚动。
- Shell 一开始就完整渲染。已有 consent checking、采集 loading、工作台 checking、unsupported/error 均使用同一固定框架，不等待存储、后台或网络结果才确定尺寸。
- 同意设置 get/set 增加 3 秒截止和卸载取消；读写失败/超时继续禁止采集，显示说明及可再次明确同意的操作，不自动重试。迟到结果不改变当次失败状态或自动触发采集。

Chrome storage.set 不能取消底层写入：超时后仍可能落盘，但当次界面保持未同意，不采集；以后重新打开只能读取用户之前明确点击产生的同意记录。没有删除队列、配对或商品资料。

初始化挂起是单独确认的缺口，不冒充小窗口的 CSS 根因。工作台原已有 3 秒超时；其他后台消息较慢时仍显示完整 Shell，本次没有给保存/配对请求加自动重发或改变付费授权。

## 回归范围与结果入口

静态 CSS guard 禁止根尺寸重新引入 vw/vh/dvh 等 viewport 依赖；单测覆盖首次检查、loading、存储失败/超时/迟到、卸载、工作台 timeout、后台 pending 和 unsupported。Playwright 新增真实 action target 测量及合成长文本内部滚动断言，完整业务链仍保留。

完整实际命令、通过数量、初始失败与修正日志、便携/升级、ZIP 与哈希见 [机器验收报告](rc2-hotfix-results.json)。全部测试仅使用隔离合成资料、Mock/Stub；没有收费 AI 请求，没有使用用户生产资料执行删除或恢复。

本次 100%/125%/150%/200% 的 CFT scale 参数只算**模拟 DPR 工程检查**，不算 Windows 显示设置人工验收。CSS px 是布局单位，截图/外框物理像素会受系统缩放、Chrome UI、边框及截图方式影响，不能只除以一个未经记录的倍率推算。

## 全量工程验收结果

| 检查                                                 | 实际结果                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                     | 通过，无依赖变更                                                             |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | 通过                                                                         |
| `pnpm test`                                          | 72 文件，735/735；较收尾基线新增 22 项单测                                   |
| `pnpm build`                                         | Extension 和 Next.js 生产构建通过                                            |
| Windows / Extension 打包                             | 两个独立 rc.2 ZIP 已生成，内嵌扩展与独立 ZIP 一致                            |
| `pnpm test:e2e`                                      | 34/34，含新增实际 action Popup 与原完整业务链                                |
| `pnpm test:portable`                                 | 13/13                                                                        |
| `pnpm test:upgrade`                                  | 8 条实际旧包路径、188 项检查最终通过                                         |
| `node scripts/validate-release.mjs`                  | 4 项通过：CRC、路径、敏感文件、每个 bundle 文件 SHA、内嵌扩展、权限/CSP/版本 |
| CFT 模拟 DPR 1 / 1.25 / 1.5 / 2                      | 每次 41/41；最终包再复测 41/41，16 张截图有 provenance 与 SHA                |
| 原候选保护                                           | 20 个历史 Windows/扩展 ZIP 字节相同；10 个旧 Release 与全部原附件未改        |

升级路径与检查数：rc.1→rc.2 28、0.8→rc.2 28、0.7→rc.2 26、0.6→rc.2 22、0.5.2/0.5.1/0.5.0/0.4→rc.2 各 21。全部使用真正旧程序与同一最终新包，在独立合成资料下核对商品、ASIN、分析历史、分组标签、适用的对比/模板/内容历史、设置、配对与浏览器偏好，没有删除原断言。

失败与重跑没有隐藏：保留最初的 CSS guard 分组计数错误；原生窗口仍持单实例锁导致首次测试启动失败；PowerShell reporter 逗号未引用导致一次 QA 启动失败；0.4 升级达到 11 项数据检查后出现一次 Stop 控制器 8000ms 超时。最后一项具体延迟原因未确认，清理已释放端口，随后在**同一包、相同 8000ms 阈值**下串行复测 21 项通过。已通过的其余检查以 ZIP 与日志 SHA 核对后继续保留，没有重写失败日志或放宽时限。机器报告保留全部尝试及每次命令、时间、退出码和日志哈希。

## 正式 Chrome 修复后人工复测

2026-10-15 工程定位时，用户已授权桌面操控；Computer Use 在选择 Chrome 窗口时因无法可靠确定当前浏览器 URL 被自动安全检查终止，未点击正式 Chrome 工具栏，也没有绕过该限制。CFT 的真实 action target 证据只证明工程复现/回归。2026-10-16 的正式 Chrome 通过证据来自上方维护者直接声明，不能归到先前自动化运行。

以下为细分专项清单，各项含有维护者本次未明确确认的条件，仍保持 pending。仅 C07 的缺陷同条件复测记 pass，不把这项声明扩张为整份清单完成；无需为关闭已确认缺陷重复原操作。

| 编号 | 场景                                           | 正式 Chrome 状态 |
| ---- | ---------------------------------------------- | ---------------- |
| T01  | 正式 Google Chrome 完整版本/渠道及扩展版本确认 | pending          |
| T02  | rc.2 加载成功，固定工具栏后点击图标            | pending          |
| T03  | 首次打开（未同意），完整框架与同意说明         | pending          |
| T04  | 明确同意后关闭，再次打开                       | pending          |
| T05  | Amazon 商品详情页打开、识别、保存和主动重识别  | pending          |
| T06  | 普通网页打开，unsupported 及返回提示           | pending          |
| T07  | 工作台在线，连接/安全配对及保存                | pending          |
| T08  | 工作台离线，状态提示和已有暂存资料保持         | pending          |
| T09  | 工作台重新连接、重配与重试同步                 | pending          |
| T10  | 长内容可内部滚动，footer 可见，无横向滚动      | pending          |
| T11  | 正常重启 Chrome 后再次打开，没有闪烁/缩成小框  | pending          |

在实际 Windows **100%、125%、150%、200%** 下分别复查 T02/T03/T04/T10；只在设备所有者正常设置的环境中测试，本轮没有自动更改系统设置。每次填写：测试日期、Chrome 完整版本、Windows build、物理分辨率/系统缩放、Chrome 页面缩放、扩展来源目录/版本、Popup 外框宽高、滚动/闪烁情况和截图或连续录像文件名。截图保留完整边界并遮挡配对码、用户名等，不提交 Key、Cookie、令牌或整个浏览器 profile。

维护者已在同条件确认小黑框缺陷修复，状态现为 `fixed + manually verified`；其余 **52 项**历史人工用例及上方未覆盖的专项清单仍待验收，真实 AI 质量仍未验证。详细环境参数缺失不补造，也不将本项通过扩张为全部工具栏场景通过。

## 安装 rc.2 与资料保护

Windows ZIP 全部解压到新目录，先正常停止旧工作台，再双击新目录的 ProductSpy.cmd；用户资料仍在独立的 `%LOCALAPPDATA%\ProductSpy`，不要删除或覆盖该目录。先导出完整业务备份并保留私人回退副本。

扩展升级要保留既有 ID 与存储。对于自己安装的长期 unpacked 目录，保留旧代码副本后，用 rc.2 扩展文件更新**该安装目录**，在扩展管理页重新加载；不修改本项目冻结 rc.1 原包/验收目录。如果改为加载新的路径，扩展 ID 可能变化，需要重新配对；旧 ID 的离线队列不会自动迁移，先同步，未同步前不要卸载旧扩展。无法通过小窗操作时可临时从扩展自己的 `popup.html` 标签页完成同步，这不是修复后工具栏验收。

工作台网页「安装与配对」是同页弹层；Windows 启动器是原生窗口；二者不能替代本次 action Popup 的复测。

Manifest 数字版本为 `1.0.0.2`，version_name 为 `1.0.0-rc.2`，高于 rc.1 的 `1.0.0`。将来正式 1.0.0 的 Chrome 数字版本也必须继续递增，不能回退三段数字。rc.2 Release 仅创建草稿，不公开、不提交 Chrome Web Store。

实际 Release 状态、源码 target、附件清单与远程摘要见 [发布交付回执](rc2-release.json)。Windows ZIP：`3165c457d58e8925f027f7dabf678efd37925a80c8e605885e3c51f600af913a`；Extension ZIP：`f422d4a653499ca9b45e7527128d2ad78c89053993f0a2a58d8d9ee656e9b6d8`。附件附带 SHA256SUMS.txt，rc.1 原文件和草稿附件保持不变。
