import type { AIProviderId, AIProviderPreset } from '@productspy/shared';
import { AppError } from '../server/errors';

// Endpoint presets are configuration aids, not a claim that every model has been verified.
// Administrators provide the model whitelist and choose a region matching their API key.
export const AI_PROVIDER_PRESETS: AIProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    documentationUrl:
      'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    documentationUrl: 'https://platform.claude.com/docs/en/api/messages/create',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    documentationUrl: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    documentationUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 / 通义千问',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    documentationUrl:
      'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
  },
  {
    id: 'volcengine',
    label: '火山方舟 / 豆包',
    protocol: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    documentationUrl: 'https://docs.volcengine.com/docs/ark/base-url-and-authentication',
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    documentationUrl: 'https://platform.kimi.com/docs/get-api-key',
  },
  {
    id: 'zhipu',
    label: '智谱 / GLM',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    documentationUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
  },
  {
    id: 'qianfan',
    label: '百度千帆 / 文心',
    protocol: 'openai-compatible',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    documentationUrl: 'https://ai.baidu.com/ai-doc/WENXINWORKSHOP/2m3fihw8s',
  },
  {
    id: 'hunyuan',
    label: '腾讯 TokenHub / 混元',
    protocol: 'openai-compatible',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    documentationUrl: 'https://cloud.tencent.com/document/product/1823/130078',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimax.cn/v1',
    documentationUrl: 'https://platform.minimax.cn/docs/api-reference/text-openai-api',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    documentationUrl: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    documentationUrl: 'https://openrouter.ai/docs/api_reference/overview',
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容服务',
    protocol: 'openai-compatible',
    baseUrl: '',
    documentationUrl:
      'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create',
  },
];

export function providerPreset(id: AIProviderId): AIProviderPreset {
  const preset = AI_PROVIDER_PRESETS.find((item) => item.id === id);
  if (!preset) throw new AppError(400, 'AI 服务商不受支持，请选择预设或自定义兼容服务');
  return { ...preset };
}
