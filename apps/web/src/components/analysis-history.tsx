'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  AnalysisMetadata,
  AnalysisVersion,
  Product,
  ProductAnalysis,
} from '@productspy/shared';
import {
  analysisDifferences,
  analysisFieldLabels,
  analysisFieldText,
  downloadAnalysis,
} from './analysis-export';
import { analysisOptionsSummary } from './analysis-preferences';
import { Button, CopyButton } from './ui';
import { isLegacyMode } from '../lib/session';
import { aiSourceLabel } from './ai-channel-selector';

const versionKinds: Record<AnalysisVersion['kind'], string> = {
  legacy: '旧版分析',
  generated: '生成结果',
  edited: '人工编辑',
  restored: '历史恢复',
};
function readableDate(date: string): string {
  return new Date(date).toLocaleString('zh-CN', { hour12: false });
}

export function analysisProvenance(metadata?: AnalysisMetadata): string {
  if (!metadata) return '旧版分析：未记录生成参数、模型和用量；请自行核对内容来源。';
  return [
    metadata.mode === 'mock'
      ? `${isLegacyMode ? '本机演示' : 'Mock 演示'} · 未调用外部模型`
      : metadata.mode === 'real'
        ? `真实 AI · ${aiSourceLabel(metadata) || '渠道和模型未记录'}`
        : '旧版分析',
    analysisOptionsSummary(metadata.options),
    ...(metadata.options.customInstructions
      ? [`自定义要求：${metadata.options.customInstructions}`]
      : []),
    `生成时间：${readableDate(metadata.generatedAt)}`,
    `商品资料基线：${readableDate(metadata.sourceUpdatedAt)}`,
    ...(metadata.selectedFields &&
    metadata.selectedFields.length < Object.keys(analysisFieldLabels).length
      ? [
          `本次参数仅应用：${metadata.selectedFields.map((field) => analysisFieldLabels[field]).join('、')}。其余内容保留原版本，可能采用不同的语言、模型或人工修改；证据区来自本次生成。`,
        ]
      : []),
  ].join(' · ');
}

type CompareVersion = {
  id: string;
  label: string;
  analysis: ProductAnalysis;
  metadata?: AnalysisMetadata;
};

export function AnalysisHistory({
  product,
  disabled,
  hasDraft,
  onRestore,
}: {
  product: Product;
  disabled: boolean;
  hasDraft: boolean;
  onRestore: (versionId: string) => Promise<void>;
}) {
  const [beforeId, setBeforeId] = useState<string>();
  const [afterId, setAfterId] = useState('current');
  const [confirmation, setConfirmation] = useState<AnalysisVersion>();
  const dialog = useRef<HTMLDialogElement>(null);
  const history = product.analysisHistory ?? [];
  const versions: CompareVersion[] = [
    ...(product.aiAnalysis
      ? [
          {
            id: 'current',
            label: '当前分析',
            analysis: product.aiAnalysis,
            metadata: product.analysisMetadata,
          },
        ]
      : []),
    ...[...history].reverse().map((version) => ({
      ...version,
      label: `${versionKinds[version.kind]} · ${readableDate(version.createdAt)}`,
    })),
  ];
  const before = versions.find((version) => version.id === beforeId) ?? versions.at(-1);
  const after = versions.find((version) => version.id === afterId) ?? versions[0];
  const differences = before && after ? analysisDifferences(before.analysis, after.analysis) : [];
  useEffect(() => {
    if (confirmation && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [confirmation]);
  const close = () => {
    dialog.current?.close();
    setConfirmation(undefined);
  };
  return (
    <details className="analysis-history">
      <summary>
        <strong>分析版本与比较</strong>
        <span>
          {history.length ? `已保存 ${history.length} 个版本` : '生成或保存修改后会自动保留版本'}
        </span>
      </summary>
      <p className="analysis-field-hint">
        重新生成、人工修改和历史恢复都会保留已保存结果。历史恢复会创建一个新版本；本标签页草稿不会被删除。
        {history.length >= 50
          ? '版本已达 50 个上限，不能新增保存或生成；现有版本不会被自动删除。请先导出需要的内容。'
          : ''}
      </p>
      {history.length > 0 ? (
        <>
          <div className="analysis-history-list">
            {[...history].reverse().map((version, index) => (
              <div className="analysis-history-row" key={version.id}>
                <div>
                  <strong>
                    {versionKinds[version.kind]} {index === 0 && '· 最近保存'}
                  </strong>
                  <p>{readableDate(version.createdAt)}</p>
                  <small>
                    {version.metadata?.mode === 'mock'
                      ? isLegacyMode
                        ? '本机演示'
                        : 'Mock 演示'
                      : version.metadata?.mode === 'real'
                        ? `真实 AI · ${aiSourceLabel(version.metadata) || '渠道和模型未记录'}`
                        : '来源未完整记录'}
                  </small>
                </div>
                <div className="analysis-inline-actions">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setBeforeId(version.id);
                      setAfterId('current');
                    }}
                  >
                    与当前比较
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      downloadAnalysis(
                        product,
                        version.analysis,
                        'md',
                        analysisProvenance(version.metadata),
                      )
                    }
                  >
                    导出版本
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => setConfirmation(version)}
                  >
                    恢复版本
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="analysis-comparison-selectors">
            <label>
              比较版本 A
              <select
                aria-label="比较版本 A"
                value={before?.id ?? ''}
                onChange={(event) => setBeforeId(event.currentTarget.value)}
              >
                {versions.map((version) => (
                  <option value={version.id} key={version.id}>
                    {version.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              比较版本 B
              <select
                aria-label="比较版本 B"
                value={after?.id ?? ''}
                onChange={(event) => setAfterId(event.currentTarget.value)}
              >
                {versions.map((version) => (
                  <option value={version.id} key={version.id}>
                    {version.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {before && after && (
            <div className="analysis-comparison">
              <p role="status">
                {differences.length ? `${differences.length} 个内容字段不同` : '两个版本的内容一致'}
              </p>
              {differences.map((field) => (
                <section key={field}>
                  <h3>{analysisFieldLabels[field]}</h3>
                  <div className="analysis-comparison-columns">
                    {[before, after].map((version, index) => (
                      <div key={`${version.id}-${index}`}>
                        <strong>版本 {index === 0 ? 'A' : 'B'}</strong>
                        <p>{analysisFieldText(version.analysis[field])}</p>
                        <CopyButton
                          value={analysisFieldText(version.analysis[field])}
                          label="复制此版本内容"
                        />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="analysis-field-hint">
          暂时没有历史版本。旧版结果会在首次修改或重新生成时自动保留。
        </p>
      )}
      {confirmation && (
        <dialog
          ref={dialog}
          className="analysis-dialog"
          aria-labelledby="analysis-restore-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!disabled) close();
          }}
        >
          <h2 id="analysis-restore-title">恢复这个历史版本？</h2>
          <p>
            当前已保存结果会保留，恢复的结果成为新的当前版本。
            {hasDraft
              ? '你还有未保存草稿，它仍会保留，但保存时可能发生版本冲突，请先导出需要的修改。'
              : ''}
          </p>
          <div className="analysis-dialog-actions">
            <Button variant="secondary" onClick={close} disabled={disabled}>
              取消
            </Button>
            <Button
              disabled={disabled}
              onClick={() => {
                const id = confirmation.id;
                close();
                void onRestore(id);
              }}
            >
              确认恢复版本
            </Button>
          </div>
        </dialog>
      )}
    </details>
  );
}
