'use client';

import type { ContentOptions } from '@productspy/shared';
import { analysisOptionChoices, type AnalysisPricingPreference } from './analysis-preferences';
import { Button } from './ui';

const labels = {
  market: '目标市场',
  language: '输出语言',
  platform: '内容平台',
  style: '内容风格',
  goal: '营销目标',
} as const;
export function ContentOptionsPanel({
  options,
  pricing,
  disabled,
  message,
  onChange,
  onPricing,
  onSave,
}: {
  options: ContentOptions;
  pricing: AnalysisPricingPreference;
  disabled: boolean;
  message: string;
  onChange: (value: ContentOptions) => void;
  onPricing: (value: AnalysisPricingPreference) => void;
  onSave: () => void;
}) {
  return (
    <details className="creation-panel">
      <summary>创作参数与请求设置</summary>
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, marginTop: 16 }}>
        <div className="creation-fields">
          {(Object.keys(labels) as (keyof typeof labels)[]).map((field) => (
            <label className="creation-field" key={field}>
              {labels[field]}
              <select
                aria-label={labels[field]}
                value={options[field]}
                onChange={(event) => onChange({ ...options, [field]: event.target.value })}
              >
                {analysisOptionChoices[field].map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="creation-field">
            视频时长（秒）
            <input
              type="number"
              min={5}
              max={180}
              step={1}
              aria-label="视频时长（秒）"
              value={options.duration}
              onChange={(event) => onChange({ ...options, duration: Number(event.target.value) })}
            />
            <div className="creation-actions">
              {[15, 30, 60].map((duration) => (
                <Button
                  key={duration}
                  variant="ghost"
                  onClick={() => onChange({ ...options, duration })}
                >
                  {duration} 秒
                </Button>
              ))}
            </div>
            <small>支持 5–180 秒；时长由口播与拍摄共同决定，文本估算不代表实拍结果。</small>
          </label>
          <label className="creation-field creation-field-wide">
            本次创意方向
            <input
              aria-label="本次创意方向"
              maxLength={1000}
              value={options.creativeDirection}
              onChange={(event) => onChange({ ...options, creativeDirection: event.target.value })}
              placeholder="例如：日常办公演示、旅行收纳场景"
            />
          </label>
          <label className="creation-field creation-field-wide">
            自定义内容要求
            <textarea
              aria-label="自定义内容要求"
              rows={3}
              maxLength={4000}
              value={options.customInstructions}
              onChange={(event) => onChange({ ...options, customInstructions: event.target.value })}
              placeholder="例如：只安排室内可拍的镜头，不承诺未验证的功效。"
            />
          </label>
          <label className="creation-field creation-field-wide">
            追加 Prompt
            <textarea
              aria-label="追加 Prompt"
              rows={3}
              maxLength={4000}
              value={options.customPrompt}
              onChange={(event) => onChange({ ...options, customPrompt: event.target.value })}
            />
            <small>不填写 Key 或私人资料。模板、追加指令与页面文本不能覆盖固定安全规则。</small>
          </label>
        </div>
        <details style={{ marginTop: 16 }}>
          <summary>可选：自填费用估算单价</summary>
          <p className="creation-note">美元 / 百万 Token，留空代表未知；费用以服务商账单为准。</p>
          <div className="creation-fields">
            {(
              [
                { field: 'inputUsdPerMillion', label: '输入单价' },
                { field: 'outputUsdPerMillion', label: '输出单价' },
              ] as const
            ).map(({ field, label }) => (
              <label className="creation-field" key={field}>
                {label}
                <input
                  aria-label={label}
                  type="number"
                  min={0}
                  max={10000}
                  step="any"
                  value={pricing[field] ?? ''}
                  onChange={(event) =>
                    onPricing({
                      ...pricing,
                      [field]: event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                />
              </label>
            ))}
          </div>
        </details>
        <div className="creation-actions" style={{ marginTop: 16 }}>
          <Button variant="secondary" onClick={onSave}>
            保存创作偏好
          </Button>
          <span className="creation-note" role="status">
            {message}
          </span>
        </div>
        <p className="creation-note">
          模型、API 地址与 Key 在 Windows 启动器的 AI 设置中配置，Key 仅由服务端读取。
        </p>
      </fieldset>
    </details>
  );
}
