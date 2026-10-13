'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CONTENT_FIELDS,
  contentFieldLabels,
  TEMPLATE_VARIABLES,
  templateDefinitionSchema,
  previewTemplateVariables,
  validateTemplateVariables,
  type TemplateDefinition,
  type TemplateVariable,
  type Product,
} from '@productspy/shared';
import { LibraryDialog } from './library-dialog';
import { Button, ErrorNotice } from './ui';

const variableLabels: Record<TemplateVariable, string> = {
  product_title: '商品名称',
  brand: '品牌',
  price: '价格',
  currency: '货币',
  bullet_points: '已采集卖点',
  description: '商品描述',
  market: '目标市场',
  language: '输出语言',
  platform: '内容平台',
  duration: '视频时长',
  style: '内容风格',
  goal: '营销目标',
  comparison_conclusions: '有来源的对比结论',
};
export const emptyTemplateDefinition: TemplateDefinition = {
  name: '',
  description: '',
  scenario: '',
  category: '自定义',
  tags: [],
  favorite: false,
  prompt:
    '依据 {{product_title}} 的已采集资料，面向 {{market}} 市场生成 {{language}} 营销内容。页面卖点：{{bullet_points}}。缺失信息标明未知。',
  outputFields: [...CONTENT_FIELDS],
  outputRequirements:
    '使用可编辑纯文本。脚本按 Hook / Problem / Solution / Demo / CTA 五段组织；开场至少五条；明确事实、商家声明与 AI 推断。',
};

export function TemplateEditor({
  initial,
  title,
  products,
  busy,
  onClose,
  onSave,
}: {
  initial: TemplateDefinition;
  title: string;
  products: Product[];
  busy: boolean;
  onClose: () => void;
  onSave: (definition: TemplateDefinition) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [tags, setTags] = useState(initial.tags.join('，'));
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const variables = validateTemplateVariables(`${value.prompt}\n${value.outputRequirements}`);
  const product = products.find((item) => item.id === productId);
  const preview = useMemo(() => {
    const values: Partial<Record<TemplateVariable, string>> = {
      product_title: product?.title,
      brand: product?.brand,
      price: product?.price,
      currency: product?.currency,
      bullet_points: product?.bulletPoints.join('\n'),
      description: product?.description,
      market: '美国',
      language: '中文',
      platform: 'TikTok',
      duration: '30',
      style: '生活化',
      goal: '了解与比较',
    };
    try {
      return {
        value: previewTemplateVariables(
          `${value.prompt}\n\n输出要求：${value.outputRequirements}`,
          values,
        ),
        error: '',
      };
    } catch (cause) {
      return {
        value: undefined,
        error: cause instanceof Error ? cause.message : '模板预览失败，请检查变量。',
      };
    }
  }, [value.prompt, value.outputRequirements, product]);
  function change(patch: Partial<TemplateDefinition>) {
    setValue((current) => ({ ...current, ...patch }));
    setDirty(true);
  }
  function close() {
    if (!dirty || window.confirm('尚有未保存的模板修改，确定放弃吗？')) onClose();
  }
  async function save() {
    const parsed = templateDefinitionSchema.safeParse({
      ...value,
      tags: [
        ...new Set(
          tags
            .split(/[,，]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ],
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join('；'));
      return;
    }
    setError('');
    try {
      await onSave(parsed.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请保留修改后重试。');
    }
  }
  return (
    <LibraryDialog title={title} busy={busy} onClose={close}>
      <div className="creation-fields">
        <label className="creation-field">
          模板名称
          <input
            aria-label="模板名称"
            maxLength={120}
            value={value.name}
            disabled={busy}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
        <label className="creation-field">
          分类
          <input
            aria-label="模板分类"
            maxLength={80}
            value={value.category}
            disabled={busy}
            onChange={(event) => change({ category: event.target.value })}
          />
        </label>
        <label className="creation-field creation-field-wide">
          描述
          <textarea
            aria-label="模板描述"
            maxLength={2000}
            rows={2}
            value={value.description}
            disabled={busy}
            onChange={(event) => change({ description: event.target.value })}
          />
        </label>
        <label className="creation-field">
          适用场景
          <input
            aria-label="适用场景"
            maxLength={400}
            value={value.scenario}
            disabled={busy}
            onChange={(event) => change({ scenario: event.target.value })}
          />
        </label>
        <label className="creation-field">
          标签
          <input
            aria-label="模板标签"
            value={tags}
            disabled={busy}
            onChange={(event) => {
              setTags(event.target.value);
              setDirty(true);
            }}
          />
          <small>用中文或英文逗号分隔，最多 20 个。</small>
        </label>
        <label className="creation-field creation-field-wide">
          模板 Prompt
          <textarea
            aria-label="模板 Prompt"
            maxLength={16000}
            rows={7}
            value={value.prompt}
            disabled={busy}
            onChange={(event) => change({ prompt: event.target.value })}
          />
        </label>
        <div className="creation-field creation-field-wide">
          <span>可用变量 · 点击插入</span>
          <div className="template-variables">
            {TEMPLATE_VARIABLES.map((variable) => (
              <button
                type="button"
                key={variable}
                disabled={busy}
                title={`{{${variable}}}`}
                onClick={() => change({ prompt: `${value.prompt} {{${variable}}}` })}
              >
                {variableLabels[variable]}
              </button>
            ))}
          </div>
        </div>
        <fieldset className="creation-field creation-field-wide" disabled={busy}>
          <legend>结构化输出内容</legend>
          <div className="creation-checks">
            {CONTENT_FIELDS.map((field) => (
              <label key={field}>
                <input
                  type="checkbox"
                  checked={value.outputFields.includes(field)}
                  onChange={(event) =>
                    change({
                      outputFields: event.target.checked
                        ? [...value.outputFields, field]
                        : value.outputFields.filter((item) => item !== field),
                    })
                  }
                />
                {contentFieldLabels[field]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="creation-field creation-field-wide">
          结构化输出要求
          <textarea
            aria-label="结构化输出要求"
            maxLength={4000}
            rows={3}
            value={value.outputRequirements}
            disabled={busy}
            onChange={(event) => change({ outputRequirements: event.target.value })}
          />
          <small>要求作为内容指令处理，不能覆盖系统事实边界、读取 Key 或执行操作。</small>
        </label>
      </div>
      {!variables.valid && <ErrorNotice message={variables.errors.join('；')} />}
      <details className="creation-panel" style={{ marginTop: 18 }}>
        <summary>变量预览 · 不调用 AI</summary>
        <label className="creation-field" style={{ marginTop: 12 }}>
          预览商品
          <select
            aria-label="预览商品"
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
          >
            <option value="">未选择商品</option>
            {products.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        {preview.value && (
          <>
            <p className="creation-note">
              {preview.value.missingVariables.length
                ? `缺失变量：${preview.value.missingVariables.map((variable) => variableLabels[variable]).join('、')}，显示为未知。`
                : '所有引用变量均有值。'}
            </p>
            <pre className="template-preview">{preview.value.text}</pre>
          </>
        )}
      </details>
      {preview.error && <ErrorNotice message={preview.error} />}
      {error && <ErrorNotice message={error} />}
      <div className="creation-actions" style={{ marginTop: 20 }}>
        <Button disabled={busy || !variables.valid} onClick={() => void save()}>
          {busy ? '正在保存…' : '保存模板'}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={close}>
          取消
        </Button>
      </div>
    </LibraryDialog>
  );
}
