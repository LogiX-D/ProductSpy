'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  contentMediaChoiceGroups,
  canonicalMediaUrl,
  errorMessage,
  type ContentPlan,
  type ContentSelectedMedia,
} from '@productspy/shared';
import { getContentPlan, updateContentPlan } from '../lib/content-api';
import { Button, ErrorNotice } from './ui';

export function ContentMediaSelection({
  plan,
  disabled,
  onUpdate,
  onBusy,
  onDirty,
}: {
  plan: ContentPlan;
  disabled: boolean;
  onUpdate: (plan: ContentPlan) => void;
  onBusy: (value: boolean) => void;
  onDirty: (value: boolean) => void;
}) {
  const choices = useMemo(
    () => contentMediaChoiceGroups(plan.productSnapshot),
    [plan.productSnapshot],
  );
  const [sources, setSources] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<ContentSelectedMedia>(plan.selectedMedia ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const baselineSelection = useRef(JSON.stringify(plan.selectedMedia ?? []));
  const dirty = JSON.stringify(selected) !== JSON.stringify(plan.selectedMedia ?? []);
  useEffect(() => {
    if (JSON.stringify(selected) === baselineSelection.current)
      setSelected(plan.selectedMedia ?? []);
    baselineSelection.current = JSON.stringify(plan.selectedMedia ?? []);
    // Keep a local unsaved selection if another operation updates the plan. Writes still use CAS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id, plan.updatedAt]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(saving);
    return () => onBusy(false);
  }, [saving, onBusy]);
  async function save() {
    if (saving || disabled) return;
    setSaving(true);
    setError('');
    try {
      onUpdate(await updateContentPlan(plan, { selectedMedia: selected }));
      setMessage(
        '素材来源选择已保存。旧内容版本仍保留生成时的素材记录。不会上传媒体，也不会调用 AI。',
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="integration-snapshot">
      <summary>
        选择创作参考素材 · 已选 {selected.length} / 50{dirty ? '（未保存）' : ''}
      </summary>
      <p>
        只选择此方案保存的商品素材来源，用于准备拍摄及导出来源说明。AI 仅收到选择数量，不发送 URL
        或文件；不支持的 HLS 和非白名单资源不可选。
      </p>
      {!choices.length && <p>此商品快照没有可安全选择的图片或 MP4 / WebM 视频。</p>}
      <div className="integration-media-grid">
        {choices.map((asset, index) => {
          const members = new Set(asset.variants.map((value) => canonicalMediaUrl(value.url)));
          const selectedSources = selected.filter(
            (value) => value.kind === asset.kind && members.has(canonicalMediaUrl(value.url)),
          );
          const checked = selectedSources.length > 0;
          const savedSource = asset.variants.find(
            (variant) =>
              selectedSources[0] &&
              canonicalMediaUrl(variant.url) === canonicalMediaUrl(selectedSources[0].url),
          )?.url;
          const source = sources[asset.id] ?? savedSource ?? asset.url;
          const removeAsset = (values: ContentSelectedMedia) =>
            values.filter(
              (value) => value.kind !== asset.kind || !members.has(canonicalMediaUrl(value.url)),
            );
          return (
            <div key={asset.id} className="integration-media-choice">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || saving || (!checked && selected.length >= 50)}
                aria-label={`创作参考${asset.kind === 'image' ? '图片' : '视频'} ${index + 1}`}
                onChange={(event) => {
                  setSelected((current) =>
                    event.target.checked
                      ? [...removeAsset(current), { kind: asset.kind, url: source }]
                      : removeAsset(current),
                  );
                  setMessage('');
                }}
              />
              {asset.kind === 'image' ? (
                <img
                  src={source}
                  alt={`保存的商品图片 ${index + 1}`}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="integration-video-label">视频来源</span>
              )}
              <span>
                {asset.kind === 'image' ? '图片' : '视频'} {index + 1}
                <small>{new URL(source).pathname.split('/').at(-1)}</small>
              </span>
              {asset.variants.length > 1 && (
                <select
                  aria-label={`参考${asset.kind === 'image' ? '图片' : '视频'} ${index + 1}来源`}
                  value={source}
                  disabled={disabled || saving}
                  onChange={(event) => {
                    const url = event.target.value;
                    setSources((current) => ({ ...current, [asset.id]: url }));
                    if (checked)
                      setSelected((current) => [
                        ...removeAsset(current),
                        { kind: asset.kind, url },
                      ]);
                    setMessage('');
                  }}
                >
                  {asset.variants.map((variant, i) => (
                    <option key={variant.url} value={variant.url}>
                      {variant.width && variant.height
                        ? `${variant.width} × ${variant.height}`
                        : '页面尺寸未知'}{' '}
                      · 来源 {i + 1}
                    </option>
                  ))}
                </select>
              )}
              {selectedSources.length > 1 && (
                <small className="integration-media-source-note">
                  此前保存 {selectedSources.length}{' '}
                  个来源；明确切换来源或取消勾选后才合并，不改变历史版本。
                </small>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <>
          <ErrorNotice
            message={`素材选择未保存：${error}。当前选择仍保留，请核对最新方案后重试。`}
          />
          <Button
            variant="secondary"
            disabled={disabled || saving}
            onClick={() => {
              if (!window.confirm('放弃当前未保存的素材选择，重新载入已保存方案？')) return;
              setSaving(true);
              void getContentPlan(plan.id)
                .then((value) => {
                  setSelected(value.selectedMedia ?? []);
                  setSources({});
                  onUpdate(value);
                  setError('');
                  setMessage('已重新载入最新方案与保存的素材选择。');
                })
                .catch((cause: unknown) => setError(errorMessage(cause)))
                .finally(() => setSaving(false));
            }}
          >
            重新载入已保存素材选择
          </Button>
        </>
      )}
      {message && (
        <p role="status" className="creation-notice">
          {message}
        </p>
      )}
      <div className="creation-actions">
        <Button disabled={disabled || saving || !dirty} onClick={() => void save()}>
          {saving ? '正在保存素材选择…' : '保存素材选择'}
        </Button>
        <Button
          variant="secondary"
          disabled={disabled || saving || !dirty}
          onClick={() => {
            setSelected(plan.selectedMedia ?? []);
            setSources({});
            setError('');
            setMessage('已取消未保存的素材选择。');
          }}
        >
          取消素材选择改动
        </Button>
      </div>
    </details>
  );
}
