import { z } from 'zod';

export const CONTENT_FIELDS = [
  'sellingCopy',
  'shortVideoScript',
  'hooks',
  'storyboard',
  'voiceover',
  'titlesDescriptions',
  'imagePrompts',
  'videoPrompts',
  'adAngles',
] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];
export const contentFieldLabels: Record<ContentField, string> = {
  sellingCopy: '商品卖点文案',
  shortVideoScript: '短视频脚本',
  hooks: '开场文案',
  storyboard: '分镜脚本',
  voiceover: '口播文案',
  titlesDescriptions: '视频标题与说明',
  imagePrompts: '图片生成提示词',
  videoPrompts: '视频生成提示词',
  adAngles: '广告创意方向',
};
export const TEMPLATE_VARIABLES = [
  'product_title',
  'brand',
  'price',
  'currency',
  'bullet_points',
  'description',
  'market',
  'language',
  'platform',
  'duration',
  'style',
  'goal',
  'comparison_conclusions',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
const allowedVariables = new Set<string>(TEMPLATE_VARIABLES);
export const MAX_TEMPLATES = 200;
export const MAX_TEMPLATE_VERSIONS = 50;
export const MAX_TEMPLATE_BACKUP_BYTES = 25 * 1024 * 1024;
export const MAX_TEMPLATE_RENDERED_CHARACTERS = 64000;

/** Only recognizes plain identifiers; never executes code or recursively substitutes page text. */
export function validateTemplateVariables(text: string): {
  valid: boolean;
  variables: TemplateVariable[];
  errors: string[];
} {
  const variables = new Set<TemplateVariable>();
  const errors: string[] = [];
  const remaining = text.replace(
    /(?<!\{)\{\{\s*([a-z_]+)\s*\}\}(?!\})/g,
    (_match, variable: string) => {
      if (allowedVariables.has(variable)) variables.add(variable as TemplateVariable);
      else errors.push(`不支持模板变量：${variable}`);
      return '';
    },
  );
  if (remaining.includes('{{') || remaining.includes('}}'))
    errors.push('模板变量必须使用完整的 {{variable_name}}，不能包含表达式或函数。');
  return { valid: errors.length === 0, variables: [...variables], errors: [...new Set(errors)] };
}
export function previewTemplateVariables(
  text: string,
  values: Partial<Record<TemplateVariable, string>>,
): { text: string; variables: TemplateVariable[]; missingVariables: TemplateVariable[] } {
  const checked = validateTemplateVariables(text);
  if (!checked.valid) throw new Error(checked.errors.join('；'));
  const missingVariables = checked.variables.filter((variable) => !values[variable]?.trim());
  let renderedCharacters = text.length;
  for (const match of text.matchAll(/(?<!\{)\{\{\s*([a-z_]+)\s*\}\}(?!\})/g)) {
    const variable = match[1] as TemplateVariable;
    renderedCharacters += (values[variable]?.trim() || '未知').length - match[0].length;
  }
  if (renderedCharacters > MAX_TEMPLATE_RENDERED_CHARACTERS)
    throw new Error('模板变量展开超过 64,000 字符，请减少重复变量或缩短商品资料；未发起 AI 请求。');
  return {
    text: text.replace(
      /(?<!\{)\{\{\s*([a-z_]+)\s*\}\}(?!\})/g,
      (_match, variable: TemplateVariable) => values[variable]?.trim() || '未知',
    ),
    variables: checked.variables,
    missingVariables,
  };
}
const variableText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .superRefine((value, context) => {
      const validation = validateTemplateVariables(value);
      for (const message of validation.errors) context.addIssue({ code: 'custom', message });
    });
export const templateDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000),
    scenario: z.string().trim().max(400),
    category: z.string().trim().min(1).max(80),
    tags: z
      .array(z.string().trim().min(1).max(40))
      .max(20)
      .refine((tags) => new Set(tags).size === tags.length, '模板标签不能重复'),
    favorite: z.boolean(),
    prompt: variableText(16000),
    outputFields: z
      .array(z.enum(CONTENT_FIELDS))
      .min(1)
      .max(CONTENT_FIELDS.length)
      .refine((fields) => new Set(fields).size === fields.length, '输出内容类型不能重复'),
    outputRequirements: variableText(4000),
  })
  .strict();
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export function templateDefinition(template: TemplateDefinition): TemplateDefinition {
  return {
    name: template.name,
    description: template.description,
    scenario: template.scenario,
    category: template.category,
    tags: [...template.tags],
    favorite: template.favorite,
    prompt: template.prompt,
    outputFields: [...template.outputFields],
    outputRequirements: template.outputRequirements,
  };
}
export const templateVersionSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    kind: z.enum(['created', 'edited', 'restored']),
    snapshot: templateDefinitionSchema,
    restoredFrom: z.string().uuid().optional(),
  })
  .strict();
export type TemplateVersion = z.infer<typeof templateVersionSchema>;
export const aiTemplateSchema = templateDefinitionSchema
  .extend({
    id: z.string().uuid(),
    origin: z.enum(['builtin', 'custom']),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    versions: z.array(templateVersionSchema).min(1).max(MAX_TEMPLATE_VERSIONS),
  })
  .strict()
  .superRefine((template, context) => {
    if (new Set(template.versions.map((version) => version.id)).size !== template.versions.length)
      context.addIssue({ code: 'custom', message: '模板历史版本编号重复' });
    if (
      JSON.stringify(templateDefinition(template)) !==
      JSON.stringify(template.versions.at(-1)?.snapshot)
    )
      context.addIssue({ code: 'custom', message: '模板当前资料与最新历史版本不一致' });
  });
export type AITemplate = z.infer<typeof aiTemplateSchema>;
const customTemplatesSchema = z
  .array(aiTemplateSchema)
  .max(MAX_TEMPLATES)
  .superRefine((templates, context) => {
    if (templates.some((template) => template.origin !== 'custom'))
      context.addIssue({
        code: 'custom',
        message: '导入或数据文件仅允许用户模板，内置模板不能被覆盖',
      });
    if (new Set(templates.map((template) => template.id)).size !== templates.length)
      context.addIssue({ code: 'custom', message: '模板编号重复' });
    if (
      templates.some((template) => /^00000000-0000-4000-8000-00000000000[1-4]$/.test(template.id))
    )
      context.addIssue({ code: 'custom', message: '内置模板编号不能用于用户模板' });
  });
export const templateFileSchema = z
  .object({ schemaVersion: z.literal(1), templates: customTemplatesSchema })
  .strict();
export const templateBackupSchema = z
  .object({
    format: z.literal('productspy-templates'),
    schemaVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    templates: customTemplatesSchema,
  })
  .strict();
export type TemplateBackup = z.infer<typeof templateBackupSchema>;

const builtinDate = '2026-10-13T00:00:00.000Z';
const builtinDefinitions: TemplateDefinition[] = [
  {
    name: '商品营销内容包',
    description: '一次生成卖点、脚本、分镜、口播、标题及提示词，作为可编辑创意草稿。',
    scenario: '商品上市与内容规划',
    category: '综合内容',
    tags: ['内容包', '入门'],
    favorite: false,
    prompt:
      '围绕 {{product_title}} 为 {{market}} 市场制作 {{language}} 的 {{platform}} 营销内容。视频约 {{duration}} 秒，采用 {{style}} 风格，目标为 {{goal}}。页面卖点：{{bullet_points}}。只使用已采集资料，明确商家声明与推断，缺失资料写未知。参考已保存且有来源的对比结论：{{comparison_conclusions}}。',
    outputFields: [...CONTENT_FIELDS],
    outputRequirements:
      '各项以可编辑纯文本输出。短视频脚本使用 Hook / Problem / Solution / Demo / CTA 五段；开场文案至少五条。分镜写出镜头、动作、台词与文本时长估算，不能冒充实拍时长。',
  },
  {
    name: '短视频脚本与分镜',
    description: '聚焦可拍摄的脚本、五条开场文案和分镜执行清单。',
    scenario: '短视频拍摄前规划',
    category: '视频脚本',
    tags: ['脚本', '分镜'],
    favorite: false,
    prompt:
      '以 {{product_title}} 的页面资料为依据，为 {{platform}} 制作约 {{duration}} 秒的 {{language}} 视频方案。市场 {{market}}，风格 {{style}}，营销目标 {{goal}}。已采集卖点 {{bullet_points}}；描述 {{description}}。避免未经证实的功效或认证，未知参数不得填造。',
    outputFields: ['shortVideoScript', 'hooks', 'storyboard', 'voiceover'],
    outputRequirements:
      '脚本必须包含 Hook / Problem / Solution / Demo / CTA。至少五条不同开场。分镜包含画面、动作、台词；所有时长都是文本估算。',
  },
  {
    name: '图片与视频创意提示词',
    description: '生成给外部创作工具使用的提示词，不生成或上传实际媒体。',
    scenario: '素材创意与广告方向',
    category: '创意提示词',
    tags: ['提示词', '广告'],
    favorite: false,
    prompt:
      '为 {{product_title}} 设计适合 {{market}} 市场的 {{style}} 创意方向，使用 {{language}}。品牌 {{brand}}。已采集卖点 {{bullet_points}}。不要凭空增加规格，不暗示获得认证，不虚构使用者评价。',
    outputFields: ['imagePrompts', 'videoPrompts', 'adAngles'],
    outputRequirements:
      '每类至少三条具体创意。提示词包含场景、光线、构图或镜头动作，并说明商品外观需要人工核对；所有创意属于 AI 推断。',
  },
  {
    name: '卖点、标题与开场文案',
    description: '提炼页面卖点，形成可复制的商品文案和内容标题。',
    scenario: '日常内容文案',
    category: '营销文案',
    tags: ['卖点', '标题'],
    favorite: false,
    prompt:
      '依据 {{product_title}} 的已采集信息，制作 {{language}} 文案，面向 {{market}} 的 {{platform}} 用户，风格 {{style}}，目标 {{goal}}。页面卖点 {{bullet_points}}，价格 {{price}} {{currency}} 仅是历史采集值。',
    outputFields: ['sellingCopy', 'hooks', 'titlesDescriptions'],
    outputRequirements:
      '卖点明确标注商家自行宣称，至少五条开场，不编造销量、排名、利润、消费者评论或限时优惠。标题与说明可直接复制，但发布前由用户审核。',
  },
];
export const builtinTemplates: AITemplate[] = builtinDefinitions.map((definition, index) => {
  const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  return aiTemplateSchema.parse({
    ...definition,
    id,
    origin: 'builtin',
    createdAt: builtinDate,
    updatedAt: builtinDate,
    versions: [{ id, createdAt: builtinDate, kind: 'created', snapshot: definition }],
  });
});
