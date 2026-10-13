'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Pencil, Save, Sparkles } from 'lucide-react';
import {
  ApiRequestError,
  apiRequest,
  COMPARISON_FIELDS,
  comparisonAnalysisSchema,
  comparisonFieldLabels,
  DEFAULT_ANALYSIS_OPTIONS,
  errorMessage,
  exportComparisonMarkdown,
  type AnalysisOptions,
  type AnalysisUsageReport,
  type ComparisonAnalysis,
  type ComparisonField,
  type ComparisonPlan,
} from '@productspy/shared';
import {
  analyzeComparison,
  getComparison,
  updateComparison,
  type ComparisonGenerationRequest,
} from '../lib/comparison-api';
import { webRequest } from '../lib/session';
import { downloadLibraryFile } from '../lib/library-api';
import { AnalysisOptionsPanel } from './analysis-options';
import { AnalysisUsagePanel } from './analysis-usage';
import {
  ANALYSIS_PREFERENCES_KEY,
  analysisOptionsSummary,
  restoreAnalysisPreferences,
  type AnalysisPricingPreference,
} from './analysis-preferences';
import { LibraryDialog } from './library-dialog';
import { Badge, Button, CopyButton, EmptyState, ErrorNotice } from './ui';
import { comparisonTimestamp } from './comparison-table';

type Draft = Record<ComparisonField, string>;
const draftKey = (id: string) => `productspy:comparison-draft:v1:${id}`;
const recoveryKey = (id: string) => `productspy:comparison-request:v1:${id}`;
function toDraft(analysis: ComparisonAnalysis): Draft {
  return Object.fromEntries(
    COMPARISON_FIELDS.map((field) => [field, analysis[field].join('\n')]),
  ) as Draft;
}
function toAnalysis(draft: Draft): ComparisonAnalysis {
  return comparisonAnalysisSchema.parse(
    Object.fromEntries(
      COMPARISON_FIELDS.map((field) => [
        field,
        draft[field]
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ]),
    ),
  );
}

export function ComparisonAnalysisPanel({
  plan,
  onUpdate,
  onEditing,
}: {
  plan: ComparisonPlan;
  onUpdate: (plan: ComparisonPlan) => void;
  onEditing: (editing: boolean) => void;
}) {
  const [mode, setMode] = useState<'mock' | 'real'>();
  const [modeError, setModeError] = useState('');
  const [options, setOptions] = useState<AnalysisOptions>({ ...DEFAULT_ANALYSIS_OPTIONS });
  const [pricing, setPricing] = useState<AnalysisPricingPreference>({});
  const [preferenceMessage, setPreferenceMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editor, setEditor] = useState<{ draft: Draft; baseline: ComparisonPlan }>();
  const [retained, setRetained] = useState<{ draft: Draft; baselineUpdatedAt: string }>();
  const [pending, setPending] = useState<ComparisonGenerationRequest>();
  const [unconfirmed, setUnconfirmed] = useState<ComparisonGenerationRequest>();
  const [dialog, setDialog] = useState<
    'authorize' | 'regenerate' | 'discard' | 'restore' | 'abandon-request'
  >();
  const [restoreId, setRestoreId] = useState<string>();
  const [usage, setUsage] = useState<AnalysisUsageReport>();
  const [usageError, setUsageError] = useState('');
  const [usageLoading, setUsageLoading] = useState(false);
  const inFlight = useRef(false);

  async function loadMode() {
    setModeError('');
    try {
      const status = await apiRequest<{ mode: 'mock' | 'real' }>('/api/status');
      setMode(status.mode);
    } catch (cause) {
      setModeError(`AI 模式读取失败：${errorMessage(cause)}。请重新连接工作台后重试。`);
    }
  }
  async function loadUsage() {
    setUsageLoading(true);
    try {
      setUsage(await webRequest<AnalysisUsageReport>('/api/analysis-usage'));
      setUsageError('');
    } catch (cause) {
      setUsageError(errorMessage(cause));
    } finally {
      setUsageLoading(false);
    }
  }
  useEffect(() => {
    void loadMode();
    void loadUsage();
    try {
      const stored = restoreAnalysisPreferences(localStorage.getItem(ANALYSIS_PREFERENCES_KEY));
      setOptions(plan.analysisMetadata?.options ?? stored.options);
      setPricing(stored.pricing);
      const raw = sessionStorage.getItem(draftKey(plan.id));
      if (raw && raw.length < 2_600_000) {
        const value: unknown = JSON.parse(raw);
        if (
          value &&
          typeof value === 'object' &&
          'baselineUpdatedAt' in value &&
          typeof value.baselineUpdatedAt === 'string' &&
          'draft' in value &&
          value.draft &&
          typeof value.draft === 'object'
        ) {
          const draft = value.draft as Draft;
          if (
            COMPARISON_FIELDS.every(
              (field) => typeof draft[field] === 'string' && draft[field].length <= 360000,
            )
          )
            setRetained({ draft, baselineUpdatedAt: value.baselineUpdatedAt });
        }
      }
      const requestRaw = sessionStorage.getItem(recoveryKey(plan.id));
      if (requestRaw && requestRaw.length < 12000) {
        const value: unknown = JSON.parse(requestRaw);
        if (
          value &&
          typeof value === 'object' &&
          'requestId' in value &&
          typeof value.requestId === 'string' &&
          /^[0-9a-f-]{36}$/i.test(value.requestId) &&
          'comparisonId' in value &&
          value.comparisonId === plan.id &&
          'expectedUpdatedAt' in value &&
          typeof value.expectedUpdatedAt === 'string' &&
          'options' in value
        ) {
          const request = value as ComparisonGenerationRequest;
          const safe = restoreAnalysisPreferences(
            JSON.stringify({
              version: 1,
              options: request.options,
              pricing: request.pricing ?? {},
            }),
          );
          setUnconfirmed({
            comparisonId: plan.id,
            requestId: request.requestId,
            expectedUpdatedAt: request.expectedUpdatedAt,
            options: safe.options,
            ...(safe.pricing.inputUsdPerMillion !== undefined &&
            safe.pricing.outputUsdPerMillion !== undefined
              ? {
                  pricing: {
                    inputUsdPerMillion: safe.pricing.inputUsdPerMillion,
                    outputUsdPerMillion: safe.pricing.outputUsdPerMillion,
                  },
                }
              : {}),
          });
        }
      }
    } catch {
      setPreferenceMessage('浏览器存储不可用；本次设置和编辑仍可使用，关闭页面前请保存。');
    }
    // The parent keys this component by the plan ID, keeping edits through server updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id]);
  useEffect(() => {
    onEditing(Boolean(editor));
    return () => onEditing(false);
  }, [editor, onEditing]);
  useEffect(() => {
    if (!editor) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [editor]);

  function savePreferences() {
    try {
      localStorage.setItem(
        ANALYSIS_PREFERENCES_KEY,
        JSON.stringify({ version: 1, options, pricing }),
      );
      setPreferenceMessage('分析偏好已保存，商品分析与对比共用。');
    } catch {
      setPreferenceMessage('浏览器未允许保存偏好；本次设置仍可使用。');
    }
  }
  function beginEdit(restore = false) {
    if (!plan.analysis) return;
    setEditor({
      draft: restore && retained ? retained.draft : toDraft(plan.analysis),
      baseline: restore && retained ? { ...plan, updatedAt: retained.baselineUpdatedAt } : plan,
    });
    setMessage(restore ? '已恢复本浏览器编辑草稿；保存时仍会检查资料版本。' : '');
  }
  function changeDraft(field: ComparisonField, value: string) {
    if (!editor) return;
    const next = { ...editor, draft: { ...editor.draft, [field]: value } };
    setEditor(next);
    const saved = { draft: next.draft, baselineUpdatedAt: editor.baseline.updatedAt };
    setRetained(saved);
    try {
      sessionStorage.setItem(draftKey(plan.id), JSON.stringify(saved));
    } catch {
      setMessage('草稿仅保留在当前页面内存中；请保存后再离开。');
    }
  }
  function clearDraft() {
    setEditor(undefined);
    setRetained(undefined);
    try {
      sessionStorage.removeItem(draftKey(plan.id));
    } catch {
      /* Saved server data is authoritative. */
    }
  }
  async function saveEdit() {
    if (!editor || busy) return;
    let analysis: ComparisonAnalysis;
    try {
      analysis = toAnalysis(editor.draft);
    } catch {
      setError('每个分区需要 1–30 条内容，每条不超过 12,000 字；每行代表一条。请检查后保存。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      onUpdate(await updateComparison(editor.baseline, { analysis }));
      clearDraft();
      setMessage('编辑已保存为新版本，原分析仍在历史记录中。');
    } catch (cause) {
      setError(`保存失败：${errorMessage(cause)}。编辑草稿仍保留，请先导出草稿或核对最新方案。`);
    } finally {
      setBusy(false);
    }
  }
  function requestGeneration(request?: ComparisonGenerationRequest) {
    if (busy || !mode || editor) return;
    const prepared = request ?? {
      comparisonId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      requestId: crypto.randomUUID(),
      options: { ...options },
      ...(pricing.inputUsdPerMillion !== undefined && pricing.outputUsdPerMillion !== undefined
        ? {
            pricing: {
              inputUsdPerMillion: pricing.inputUsdPerMillion,
              outputUsdPerMillion: pricing.outputUsdPerMillion,
            },
          }
        : {}),
    };
    setPending(prepared);
    if (!request && (plan.analysis || retained || unconfirmed)) setDialog('regenerate');
    else if (mode === 'real') setDialog('authorize');
    else void generate(prepared);
  }
  async function generate(request: ComparisonGenerationRequest, authorizeReal = false) {
    if (inFlight.current || busy || !mode || (mode === 'real' && !authorizeReal)) return;
    inFlight.current = true;
    setBusy(true);
    setDialog(undefined);
    setError('');
    setMessage('');
    const safe = { ...request, authorizeReal: undefined };
    setUnconfirmed(safe);
    try {
      sessionStorage.setItem(recoveryKey(plan.id), JSON.stringify(safe));
    } catch {
      /* Never trigger a paid retry because storage failed. */
    }
    try {
      onUpdate(await analyzeComparison({ ...request, authorizeReal }));
      setUnconfirmed(undefined);
      setPending(undefined);
      try {
        sessionStorage.removeItem(recoveryKey(plan.id));
      } catch {
        /* No external retry. */
      }
      setMessage(
        mode === 'mock'
          ? '本机 Mock 对比完成；这是工作流示例，不代表真实模型质量。'
          : '真实 AI 对比已保存，请核对事实和推断。',
      );
      void loadUsage();
    } catch (cause) {
      setError(
        `${errorMessage(cause)}。未自动重试。请先检查同一次请求结果；原分析和编辑历史仍保留。`,
      );
      void loadUsage();
      if (cause instanceof ApiRequestError && cause.status === 428) void loadMode();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function checkResult() {
    if (!unconfirmed || busy) return;
    setBusy(true);
    setError('');
    try {
      const latest = await getComparison(plan.id);
      onUpdate(latest);
      if (
        latest.analysisMetadata?.requestId === unconfirmed.requestId ||
        latest.analysisHistory?.some(
          (version) => version.metadata?.requestId === unconfirmed.requestId,
        )
      ) {
        setUnconfirmed(undefined);
        try {
          sessionStorage.removeItem(recoveryKey(plan.id));
        } catch {
          /* Read-only recovery. */
        }
        setMessage('已找到并载入本次请求的结果，没有重新调用模型。');
      } else
        setMessage(
          '尚未找到本次请求的结果。可查看本机用量；继续同一次请求仍需明确操作和真实 AI 授权。',
        );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      void loadUsage();
    }
  }
  async function restoreVersion() {
    if (!restoreId || busy) return;
    setBusy(true);
    setError('');
    try {
      onUpdate(await updateComparison(plan, { restoreVersionId: restoreId }));
      setDialog(undefined);
      setMessage('历史版本已恢复为新的当前版本，所有已有版本保留。');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const analysis = plan.analysis;
  const metadata = plan.analysisMetadata;
  const modeLabel = metadata?.mode ?? mode;
  const exportPlan = editor
    ? (() => {
        try {
          return { ...plan, analysis: toAnalysis(editor.draft) };
        } catch {
          return undefined;
        }
      })()
    : plan;
  return (
    <section className="comparison-analysis" aria-label="AI 对比分析">
      <div className="comparison-section-heading">
        <div>
          <div className="ws-inline">
            <h2>AI 对比分析</h2>
            {modeLabel && (
              <Badge tone={modeLabel === 'mock' ? 'warning' : 'default'}>
                {modeLabel === 'mock' ? 'Mock · 本机演示' : '真实 AI · 需核查'}
              </Badge>
            )}
          </div>
          <p className="muted">
            只使用所选商品的页面快照，区分采集事实、商家宣称、AI 推断与未知信息。
          </p>
        </div>
        <Button
          disabled={busy || !mode || Boolean(editor) || Boolean(unconfirmed)}
          onClick={() => requestGeneration()}
        >
          <Sparkles size={15} />
          {busy ? '正在处理…' : analysis ? '重新生成对比分析' : '开始 AI 对比分析'}
        </Button>
      </div>
      {modeError && <ErrorNotice message={modeError} onRetry={() => void loadMode()} />}
      {error && <ErrorNotice message={error} />}
      {message && (
        <p role="status" className="comparison-notice">
          {message}
        </p>
      )}
      {mode === 'mock' && (
        <p className="comparison-boundary">
          未配置真实 AI 时使用本机 Mock
          示例，无外部请求和费用；示例内容不能作为真实市场研究或模型质量验收。
        </p>
      )}
      {mode === 'real' && (
        <p className="comparison-boundary">
          每次真实调用均需授权，可能产生费用。默认仅发送商品文字与链接，不上传图片和视频文件。
        </p>
      )}
      <AnalysisOptionsPanel
        options={options}
        pricing={pricing}
        fields={[]}
        hasAnalysis={false}
        disabled={busy || Boolean(editor)}
        message={preferenceMessage}
        onOptions={setOptions}
        onPricing={setPricing}
        onFields={() => undefined}
        onSave={savePreferences}
      />
      {unconfirmed && (
        <div className="comparison-recovery">
          <p>有一次请求尚未确认完成。重复点击不会自动产生新的请求。</p>
          <div className="ws-inline">
            <Button variant="secondary" disabled={busy} onClick={() => void checkResult()}>
              检查已保存结果
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !mode || Boolean(editor)}
              onClick={() => requestGeneration(unconfirmed)}
            >
              继续同一次请求
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDialog('abandon-request')}>
              结束本次请求记录
            </Button>
            <span className="muted">请求编号：{unconfirmed.requestId.slice(0, 8)}</span>
          </div>
        </div>
      )}
      {retained && !editor && (
        <div className="comparison-recovery">
          <p>发现未保存的编辑草稿，重新生成不会清除它。</p>
          <Button variant="secondary" disabled={busy || !analysis} onClick={() => beginEdit(true)}>
            恢复编辑草稿
          </Button>
        </div>
      )}
      {analysis ? (
        <>
          <div className="comparison-result-toolbar">
            <p>
              {metadata
                ? `${comparisonTimestamp(metadata.generatedAt)} · ${analysisOptionsSummary(metadata.options)}`
                : '人工保存的分析'}
              {metadata &&
                metadata.sourceUpdatedAt !== (plan.snapshotUpdatedAt ?? plan.createdAt) && (
                  <span> · 商品快照已变化，请按新资料重新核查分析。</span>
                )}
            </p>
            <div className="ws-inline">
              <CopyButton value={exportComparisonMarkdown(plan)} label="复制整篇分析" />
              <Button
                variant="secondary"
                disabled={busy || !exportPlan}
                onClick={() =>
                  exportPlan &&
                  downloadLibraryFile({
                    filename: `ProductSpy-comparison-${plan.id.slice(0, 8)}${editor ? '-draft' : ''}.md`,
                    mimeType: 'text/markdown;charset=utf-8',
                    content: exportComparisonMarkdown(exportPlan),
                    count: plan.products.length,
                  })
                }
              >
                <Download size={14} />
                {editor ? '导出编辑草稿' : '导出 Markdown'}
              </Button>
              {editor ? (
                <>
                  <Button disabled={busy} onClick={() => void saveEdit()}>
                    <Save size={14} />
                    保存编辑
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setDialog('discard')}>
                    结束编辑
                  </Button>
                </>
              ) : (
                <Button variant="secondary" disabled={busy} onClick={() => beginEdit()}>
                  <Pencil size={14} />
                  编辑结果
                </Button>
              )}
            </div>
          </div>
          <div className="comparison-analysis-grid">
            {COMPARISON_FIELDS.map((field) => (
              <section key={field} className="analysis-block">
                <div className="analysis-block-heading">
                  <h3>{comparisonFieldLabels[field]}</h3>
                  <CopyButton
                    value={editor ? editor.draft[field] : analysis[field].join('\n')}
                    label="复制分区"
                  />
                </div>
                {editor ? (
                  <label className="comparison-editor-field">
                    <span>每行一条 · 1–30 条</span>
                    <textarea
                      aria-label={`编辑${comparisonFieldLabels[field]}`}
                      value={editor.draft[field]}
                      maxLength={360000}
                      rows={Math.min(10, Math.max(4, editor.draft[field].split('\n').length + 1))}
                      disabled={busy}
                      onChange={(event) => changeDraft(field, event.currentTarget.value)}
                    />
                  </label>
                ) : (
                  <ul className="comparison-analysis-list">
                    {analysis[field].map((item, index) => (
                      <li key={index}>
                        <p>{item}</p>
                        <CopyButton value={item} label="复制条目" />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
          {metadata && (
            <details className="comparison-evidence">
              <summary>查看事实来源与分析边界</summary>
              <p>
                未采集评论正文，评分和评论数量不是用户评论内容分析。人工编辑会保留原生成证据；新增表述需自行核查。
              </p>
              <div className="comparison-evidence-grid">
                {(
                  [
                    { field: 'facts', label: 'Amazon 页面采集事实' },
                    { field: 'merchantClaims', label: '商家页面宣称（未独立验证）' },
                    { field: 'inferences', label: 'AI 推断 / 假设' },
                    { field: 'unknowns', label: '尚未验证的信息' },
                  ] as const
                ).map(({ field, label }) => (
                  <section key={field}>
                    <h3>{label}</h3>
                    {metadata.evidence[field].length ? (
                      <ul>
                        {metadata.evidence[field].map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">未提供；不能视为已验证。</p>
                    )}
                  </section>
                ))}
              </div>
            </details>
          )}
        </>
      ) : (
        <EmptyState
          title="用对比资料生成内容方向"
          description="保存 2–5 个商品的对比方案后，选择市场、语言与内容要求开始分析。所有 AI 结论均需结合实际商品确认。"
        />
      )}
      {Boolean(plan.analysisHistory?.length) && (
        <details className="comparison-history">
          <summary>分析历史 · {plan.analysisHistory?.length} 个版本</summary>
          <p className="muted">生成、编辑与恢复均保留已有版本，不会修改商品原始分析。</p>
          {[...(plan.analysisHistory ?? [])].reverse().map((version) => (
            <details key={version.id}>
              <summary>
                {comparisonTimestamp(version.createdAt)} ·{' '}
                {{ generated: 'AI 生成', edited: '人工编辑', restored: '历史恢复' }[version.kind]} ·{' '}
                {version.metadata?.mode === 'real' ? '真实 AI' : 'Mock / 人工编辑'}
              </summary>
              <div className="ws-inline">
                <CopyButton
                  value={COMPARISON_FIELDS.map(
                    (field) =>
                      `${comparisonFieldLabels[field]}\n${version.analysis[field].join('\n')}`,
                  ).join('\n\n')}
                  label="复制历史分析"
                />
                <Button
                  variant="secondary"
                  disabled={busy || Boolean(editor)}
                  onClick={() => {
                    setRestoreId(version.id);
                    setDialog('restore');
                  }}
                >
                  恢复此版本
                </Button>
              </div>
              {COMPARISON_FIELDS.map((field) => (
                <div key={field} className="comparison-history-section">
                  <strong>{comparisonFieldLabels[field]}</strong>
                  <ul>
                    {version.analysis[field].map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </details>
          ))}
        </details>
      )}
      <AnalysisUsagePanel
        report={usage}
        error={usageError}
        loading={usageLoading}
        onRefresh={() => void loadUsage()}
      />
      {dialog && (
        <LibraryDialog
          title={
            dialog === 'authorize'
              ? '授权本次真实 AI 对比请求'
              : dialog === 'regenerate'
                ? '重新生成对比分析'
                : dialog === 'restore'
                  ? '恢复历史分析'
                  : dialog === 'abandon-request'
                    ? '结束本次请求记录？'
                    : '结束编辑'
          }
          busy={busy}
          onClose={() => setDialog(undefined)}
        >
          <p>
            {dialog === 'authorize'
              ? '将向你配置的模型服务商发送此方案的商品页面文字、链接和分析要求。可能产生费用；不自动重试，也不上传媒体文件。'
              : dialog === 'regenerate'
                ? '新结果会保存为新的历史版本，原分析、人工编辑和未保存草稿仍保留。'
                : dialog === 'restore'
                  ? '将此历史分析恢复为新的当前版本，所有现有历史继续保留。'
                  : dialog === 'abandon-request'
                    ? '请先检查结果与本机用量。结束本地恢复记录不会取消已经发送给服务商的请求，也不会删除已保存的分析；之后新建的真实请求可能再次计费。'
                    : '未保存的草稿保留在本浏览器，可稍后恢复。选择“放弃草稿”才会清除。'}
          </p>
          {dialog === 'authorize' && (
            <p className="muted">
              本次为 {plan.products.length} 个商品的 1 次模型请求 ·{' '}
              {analysisOptionsSummary(pending?.options ?? options)}
              。费用以服务商账单为准，未知费用不代表免费。
            </p>
          )}
          <div className="library-dialog-footer">
            <Button
              disabled={busy}
              onClick={() => {
                if (dialog === 'authorize' && pending) void generate(pending, true);
                else if (dialog === 'regenerate' && pending) {
                  if (mode === 'real') setDialog('authorize');
                  else void generate(pending);
                } else if (dialog === 'restore') void restoreVersion();
                else if (dialog === 'abandon-request') {
                  setUnconfirmed(undefined);
                  setDialog(undefined);
                  try {
                    sessionStorage.removeItem(recoveryKey(plan.id));
                  } catch {
                    /* Explicitly abandoned local recovery only. */
                  }
                } else {
                  setEditor(undefined);
                  setDialog(undefined);
                }
              }}
            >
              {dialog === 'authorize'
                ? '授权本次调用'
                : dialog === 'regenerate'
                  ? '确认重新生成'
                  : dialog === 'restore'
                    ? '确认恢复'
                    : dialog === 'abandon-request'
                      ? '确认结束记录'
                      : '保留草稿并结束'}
            </Button>
            {dialog === 'discard' && (
              <Button
                variant="danger"
                onClick={() => {
                  clearDraft();
                  setDialog(undefined);
                }}
              >
                放弃草稿
              </Button>
            )}
            <Button variant="secondary" disabled={busy} onClick={() => setDialog(undefined)}>
              取消
            </Button>
          </div>
        </LibraryDialog>
      )}
    </section>
  );
}
