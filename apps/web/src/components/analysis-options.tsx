'use client';

import type { AnalysisField, AnalysisOptions } from '@productspy/shared';
import { analysisFieldLabels } from './analysis-export';
import {
  analysisOptionChoices,
  analysisOptionsSummary,
  type AnalysisPricingPreference,
} from './analysis-preferences';
import { Button } from './ui';

const optionLabels = {
  market: '目标市场',
  language: '输出语言',
  platform: '内容平台',
  style: '内容风格',
  duration: '视频时长',
  goal: '营销目标',
} as const;

export function AnalysisOptionsPanel({
  options,
  pricing,
  fields,
  hasAnalysis,
  disabled,
  message,
  onOptions,
  onPricing,
  onFields,
  onSave,
}: {
  options: AnalysisOptions;
  pricing: AnalysisPricingPreference;
  fields: AnalysisField[];
  hasAnalysis: boolean;
  disabled: boolean;
  message: string;
  onOptions: (options: AnalysisOptions) => void;
  onPricing: (pricing: AnalysisPricingPreference) => void;
  onFields: (fields: AnalysisField[]) => void;
  onSave: () => void;
}) {
  return (
    <details className="analysis-options" open={!hasAnalysis}>
      <summary>
        <strong>分析设置</strong>
        <span>{analysisOptionsSummary(options)}</span>
      </summary>
      <fieldset disabled={disabled} className="analysis-options-fields">
        <div className="analysis-options-grid">
          {(Object.keys(optionLabels) as (keyof typeof optionLabels)[]).map((key) => (
            <label key={key}>
              <span>{optionLabels[key]}</span>
              <select
                aria-label={optionLabels[key]}
                value={options[key]}
                onChange={(event) =>
                  onOptions({
                    ...options,
                    [key]:
                      key === 'duration'
                        ? Number(event.currentTarget.value)
                        : event.currentTarget.value,
                  })
                }
              >
                {analysisOptionChoices[key].map(({ value, label }) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <label className="analysis-options-custom">
          <span>自定义分析要求</span>
          <textarea
            aria-label="自定义分析要求"
            value={options.customInstructions}
            maxLength={4000}
            rows={3}
            placeholder="例如：聚焦通勤场景，不使用夸大的功效承诺。"
            onChange={(event) =>
              onOptions({ ...options, customInstructions: event.currentTarget.value })
            }
          />
          <small>
            {options.customInstructions.length} / 4,000 字 · 要求属于内容指令，不应填写 Key
            或私人资料。
          </small>
        </label>
        {hasAnalysis && (
          <div className="analysis-generation-scope">
            <p>
              <strong>本次重新生成</strong> · 未选择的内容保留
            </p>
            <div className="analysis-field-checks">
              {(Object.keys(analysisFieldLabels) as AnalysisField[]).map((field) => (
                <label key={field}>
                  <input
                    type="checkbox"
                    aria-label={`重新生成${analysisFieldLabels[field]}`}
                    checked={fields.includes(field)}
                    onChange={(event) =>
                      onFields(
                        event.currentTarget.checked
                          ? [...fields, field]
                          : fields.filter((item) => item !== field),
                      )
                    }
                  />
                  {analysisFieldLabels[field]}
                </label>
              ))}
            </div>
            <div className="analysis-inline-actions">
              <Button
                variant="ghost"
                onClick={() => onFields(Object.keys(analysisFieldLabels) as AnalysisField[])}
              >
                选择全部
              </Button>
              <Button variant="ghost" onClick={() => onFields([])}>
                清除选择
              </Button>
            </div>
            <p className="analysis-field-hint">
              当前会请求完整模型结果，仅合并选定内容。局部生成不代表必然节省 Token 或费用。
            </p>
          </div>
        )}
        <details className="analysis-price-settings">
          <summary>可选：自填模型单价，用于本机估算</summary>
          <p>请按你的服务商账单填写美元 / 百万 Token；留空表示费用未知，不会猜测价格。</p>
          <div className="analysis-options-grid">
            {(
              [
                { field: 'inputUsdPerMillion', label: '输入单价' },
                { field: 'outputUsdPerMillion', label: '输出单价' },
              ] as const
            ).map(({ field, label }) => (
              <label key={field}>
                <span>{label}（USD / 百万 Token）</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="10000"
                  step="any"
                  aria-label={label}
                  value={pricing[field] ?? ''}
                  onChange={(event) => {
                    const raw = event.currentTarget.value;
                    onPricing({
                      ...pricing,
                      [field]: raw === '' ? undefined : Math.min(10000, Math.max(0, Number(raw))),
                    });
                  }}
                />
              </label>
            ))}
          </div>
        </details>
        <div className="analysis-options-footer">
          <Button variant="secondary" onClick={onSave}>
            保存分析偏好
          </Button>
          <span role="status">{message}</span>
        </div>
      </fieldset>
    </details>
  );
}
