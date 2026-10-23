# AI 渠道预设与协议核验

核验日期：2026-10-23。下列预设是管理员配置入口与传输协议实现，不代表已用真实账户验证所有服务商、地区或模型。当前只执行本地 Mock / HTTP Stub 合同测试；真实调用仍需要服务商凭据、明确的测试预算和实际结果记录。

管理员统一配置渠道、服务端密钥和模型白名单，用户只能选择已启用渠道中的模型。预设不内置易过时的模型清单。模型 ID、工具调用、JSON 输出、Token 参数、温度和思考选项的支持范围，以所购服务及该模型官方文档为准；不兼容时返回错误，不自动换模型、渠道或重复收费调用。

| 预设                  | 默认 API 基址                                             | 协议与官方依据                                                                                                                      |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI                | `https://api.openai.com/v1`                               | [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)，OpenAI 兼容 |
| Anthropic Claude      | `https://api.anthropic.com/v1`                            | [Messages API](https://platform.claude.com/docs/en/api/messages/create)，原生 Messages                                              |
| Google Gemini         | `https://generativelanguage.googleapis.com/v1beta/openai` | [官方 OpenAI 兼容层](https://ai.google.dev/gemini-api/docs/openai)                                                                  |
| DeepSeek              | `https://api.deepseek.com`                                | [首次 API 调用](https://api-docs.deepseek.com/)，OpenAI 兼容；根路径直接追加 `/chat/completions`                                    |
| 阿里云百炼 / 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1`       | [OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)                                   |
| 火山方舟 / 豆包       | `https://ark.cn-beijing.volces.com/api/v3`                | [Base URL 与鉴权](https://docs.volcengine.com/docs/ark/base-url-and-authentication)，OpenAI 兼容数据面                              |
| Moonshot / Kimi       | `https://api.moonshot.cn/v1`                              | [官方快速开始](https://platform.kimi.com/docs/get-api-key)，OpenAI 兼容                                                             |
| 智谱 / GLM            | `https://open.bigmodel.cn/api/paas/v4`                    | [OpenAI API 兼容](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)                                                    |
| 百度千帆 / 文心       | `https://qianfan.baidubce.com/v2`                         | [OpenAI SDK 兼容介绍](https://ai.baidu.com/ai-doc/WENXINWORKSHOP/2m3fihw8s)，V2 API Key                                             |
| 腾讯 TokenHub / 混元  | `https://tokenhub.tencentmaas.com/v1`                     | [API 使用说明](https://cloud.tencent.com/document/product/1823/130078)，OpenAI 兼容                                                 |
| MiniMax               | `https://api.minimax.cn/v1`                               | [OpenAI SDK 接口](https://platform.minimax.cn/docs/api-reference/text-openai-api)                                                   |
| 硅基流动              | `https://api.siliconflow.cn/v1`                           | [Chat Completions API](https://docs.siliconflow.cn/docs/api/chat-completions-post)，OpenAI 兼容                                     |
| OpenRouter            | `https://openrouter.ai/api/v1`                            | [API Reference](https://openrouter.ai/docs/api_reference/overview)，OpenAI 兼容                                                     |
| 自定义                | 管理员填写                                                | 需符合上述 Chat Completions 协议；不是任意厂商原生 API 的自动适配器                                                                 |

## 地区与产品线

百炼默认填入官方仍支持的北京通用地址。官方现推荐业务空间专属域名；管理员应按账户地域替换为自己的 `WorkspaceId` 域名，API Key 与地址地域必须一致。Coding Plan、Token Plan 和按量 API 的密钥、基址不可混用。[官方地域说明](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)

腾讯预设采用 TokenHub 新入口。旧混元客户可按官方服务状态覆盖为旧入口，但新渠道应使用对应 TokenHub 凭据，不能用腾讯云 SecretId/SecretKey 冒充兼容接口 API Key。[迁移说明](https://cloud.tencent.com.cn/document/product/1823/131382)

其他境内 / 国际入口也需要与开通服务、账单和密钥匹配。本应用不主动切换地域、开通服务或购买额度。火山方舟配置的是模型调用数据面，不是 Access Key 管理面。MiniMax 按核验时官网示例使用 `api.minimax.cn`，不依赖历史拼写域名。

## Claude 原生结构化输出

服务端向 `/messages` 发送系统提示词、用户资料、`max_tokens` 和一个命名工具的 `input_schema`；通过 `tool_choice` 强制该工具，并关闭并行工具调用。工具仅承载结构化结果，本应用不执行模型请求的外部工具，也不继续第二轮模型调用。[工具定义](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)、[关闭并行工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)

当前实现明确固定官方仍列出的 `anthropic-version: 2023-06-01`，以保持该版本参数契约；不自动升级到会移除温度参数的 `2026-10-21`。`x-api-key` 仍是受支持的鉴权方式。使用绑定单一 workspace 的 API Key；本轮没有为跨 workspace 密钥添加额外 workspace 选择功能。[API 版本](https://platform.claude.com/docs/en/api/versioning)、[鉴权与 workspace](https://platform.claude.com/docs/en/api/overview)

只接受 `stop_reason=tool_use` 且恰好一个名称匹配、参数为对象的工具块，再执行现有商品分析 / 对比 / 创作 schema 校验；截断、拒绝、不匹配、多工具、无效用量均失败。用量包含响应声明的普通输入与缓存输入 Token，不推算未提供值。该模式不适用于所有 Claude 模型：某些模型不支持强制工具选择，管理员须先核验并只开放兼容模型。当前适配器显式拒绝 `thinking` 配置、文本输出模式、`max_completion_tokens` 及大于 1 的温度，不静默发送不适用参数。

## 请求边界与验收范围

两种协议共享 2 MiB 响应上限、请求 / 读取超时、禁止重定向、错误脱敏，以及每次用户提交只发起一次上游 POST 的规则。HTTP 429 可呈现有限 Retry-After 建议，但不会自动重试。OpenRouter 额外明确发送 `provider.allow_fallbacks=false` 和 `provider.require_parameters=true`，防止其默认路由回退与忽略不支持参数。[OpenRouter 路由文档](https://openrouter.ai/docs/guides/routing/provider-selection)

`multi-provider-transports.test.ts` 以本地 Mock 结果和 loopback HTTP / fetch Stub 验证各预设路径、请求头和参数、Claude 三类结构化输出、拒绝 / 截断 / 用量 / 超时 / 限流及错误脱敏。它不证明服务商真实模型质量、账户权限、价格、配额或公网连通性。真实接入后应分别记录服务商、模型 ID、地区、单次调用结果和实际账单；不得以本文件或 Stub 结果替代真实验收。
