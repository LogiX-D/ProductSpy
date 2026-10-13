'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Download, History, Pencil, Save, Sparkles } from 'lucide-react';
import {
  apiRequest,
  CONTENT_FIELDS,
  contentFieldLabels,
  contentOptionsSchema,
  contentOutputSchema,
  currentContentVersion,
  exportContentTxt,
  errorMessage,
  type ContentField,
  type ContentOptions,
  type ContentOutput,
  type ContentPlan,
  type ContentVersion,
  type AnalysisUsageReport,
} from '@productspy/shared';
import {
  generateContent,
  getContentPlan,
  updateContentPlan,
  type ContentGenerationRequest,
} from '../lib/content-api';
import { webRequest } from '../lib/session';
import { ContentOptionsPanel } from './content-options';
import { downloadContent } from './content-export';
import { CONTENT_PREFERENCES_KEY } from './content-preferences';
import type { AnalysisPricingPreference } from './analysis-preferences';
import { AnalysisUsagePanel } from './analysis-usage';
import { LibraryDialog } from './library-dialog';
import { Badge, Button, CopyButton, EmptyState, ErrorNotice } from './ui';

type Draft = Record<ContentField, string>;
const draftKey = (id: string) => `productspy:content-draft:v1:${id}`;
const requestKey = (id: string) => `productspy:content-request:v1:${id}`;
const toDraft = (output: ContentOutput): Draft =>
  Object.fromEntries(
    CONTENT_FIELDS.map((field) => [field, output[field].join('\n\n---\n\n')]),
  ) as Draft;
const toOutput = (draft: Draft): ContentOutput => {
  const parsed = contentOutputSchema.safeParse(
    Object.fromEntries(
      CONTENT_FIELDS.map((field) => [
        field,
        draft[field]
          .split(/\r?\n\s*---\s*\r?\n/)
          .map((text) => text.trim())
          .filter(Boolean),
      ]),
    ),
  );
  if (!parsed.success)
    throw new Error(
      '内容结构无效。每项需要 1–30 条、每条最多 12,000 字；开场文案至少 5 条，脚本需保留 Hook / Problem / Solution / Demo / CTA 五段。请用独立一行「---」分隔各条。',
    );
  return parsed.data;
};

export function ContentPlanPanel({
  plan,
  onUpdate,
  onEditing,
  onBusy,
}: {
  plan: ContentPlan;
  onUpdate: (value: ContentPlan) => void;
  onEditing: (value: boolean) => void;
  onBusy: (value: boolean) => void;
}) {
  const [mode, setMode] = useState<'mock' | 'real'>();
  const [modeError, setModeError] = useState('');
  const [options, setOptions] = useState<ContentOptions>(plan.options);
  const [pricing, setPricing] = useState<AnalysisPricingPreference>({});
  const [preferenceMessage, setPreferenceMessage] = useState('');
  const [selectedFields, setSelectedFields] = useState<ContentField[]>([
    ...plan.templateSnapshot.outputFields,
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editor, setEditor] = useState<{ draft: Draft; baseline: ContentPlan }>();
  const [retained, setRetained] = useState<{ draft: Draft; baselineUpdatedAt: string }>();
  const [pending, setPending] = useState<ContentGenerationRequest>();
  const [unconfirmed, setUnconfirmed] = useState<{ requestId: string; mode: 'mock' | 'real' }>();
  const [recoveryRequest, setRecoveryRequest] = useState<ContentGenerationRequest>();
  const [dialog, setDialog] = useState<'authorize' | 'restore' | 'adopt' | 'abandon'>();
  const [versionId, setVersionId] = useState<string>();
  const [compareId, setCompareId] = useState('');
  const [usage, setUsage] = useState<AnalysisUsageReport>();
  const [usageError, setUsageError] = useState('');
  const [usageLoading, setUsageLoading] = useState(false);
  const inFlight = useRef(false);
  const version = currentContentVersion(plan);
  const compared = plan.versions.find((item) => item.id === compareId);
  const candidate = plan.versions.find((item) => item.id === versionId);
  const editing = Boolean(editor);
  const dirty = Boolean(
    editor &&
    JSON.stringify(editor.draft) !==
      JSON.stringify(toDraft(currentContentVersion(editor.baseline)!.output)),
  );

  async function loadMode() {
    setModeError('');
    try {
      setMode((await apiRequest<{ mode: 'mock' | 'real' }>('/api/status')).mode);
    } catch (cause) {
      setModeError(`AI 服务状态读取失败：${errorMessage(cause)}。请连接工作台后重试。`);
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
      const raw = sessionStorage.getItem(draftKey(plan.id));
      if (raw && raw.length < 2_600_000) {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'baselineUpdatedAt' in parsed &&
          typeof parsed.baselineUpdatedAt === 'string' &&
          'draft' in parsed &&
          parsed.draft &&
          typeof parsed.draft === 'object'
        ) {
          const draft = parsed.draft as Draft;
          if (
            CONTENT_FIELDS.every(
              (field) => typeof draft[field] === 'string' && draft[field].length < 400000,
            )
          )
            setRetained({ draft, baselineUpdatedAt: parsed.baselineUpdatedAt });
        }
      }
      const request = sessionStorage.getItem(requestKey(plan.id));
      if (request && request.length < 24000) {
        const parsed: unknown = JSON.parse(request);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'requestId' in parsed &&
          typeof parsed.requestId === 'string' &&
          /^[0-9a-f-]{36}$/i.test(parsed.requestId) &&
          'mode' in parsed &&
          (parsed.mode === 'mock' || parsed.mode === 'real')
        ) {
          setUnconfirmed({ requestId: parsed.requestId, mode: parsed.mode });
          if ('request' in parsed && parsed.request && typeof parsed.request === 'object') {
            const input = parsed.request as ContentGenerationRequest;
            const safe = contentOptionsSchema.safeParse(input.options);
            if (
              safe.success &&
              input.planId === plan.id &&
              input.requestId === parsed.requestId &&
              typeof input.expectedUpdatedAt === 'string' &&
              Number.isFinite(Date.parse(input.expectedUpdatedAt)) &&
              (!input.selectedFields ||
                (Array.isArray(input.selectedFields) &&
                  input.selectedFields.every((field) => CONTENT_FIELDS.includes(field))))
            )
              setRecoveryRequest({ ...input, options: safe.data, authorizeReal: undefined });
          }
        }
      }
      const rawPreferences = localStorage.getItem(CONTENT_PREFERENCES_KEY);
      if (rawPreferences && rawPreferences.length < 20000) {
        const saved: unknown = JSON.parse(rawPreferences);
        if (
          saved &&
          typeof saved === 'object' &&
          'pricing' in saved &&
          saved.pricing &&
          typeof saved.pricing === 'object'
        ) {
          const values = saved.pricing as Record<string, unknown>;
          const safe: AnalysisPricingPreference = {};
          for (const key of ['inputUsdPerMillion', 'outputUsdPerMillion'] as const)
            if (
              typeof values[key] === 'number' &&
              Number.isFinite(values[key]) &&
              values[key] >= 0 &&
              values[key] <= 10000
            )
              safe[key] = values[key];
          setPricing(safe);
        }
      }
    } catch {
      setPreferenceMessage('浏览器草稿存储不可用，关闭页面前请保存人工修改。');
    }
    // A plan keeps its mounted editor through server updates; only its ID changes the context.
  }, [plan.id]);
  useEffect(() => {
    onEditing(editing);
    return () => onEditing(false);
  }, [editing, onEditing]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const persistDraft = useCallback(
    (value: { draft: Draft; baseline: ContentPlan }) => {
      try {
        sessionStorage.setItem(
          draftKey(plan.id),
          JSON.stringify({ draft: value.draft, baselineUpdatedAt: value.baseline.updatedAt }),
        );
      } catch {
        setPreferenceMessage('草稿存储空间不足，请保存人工修改后再离开。');
      }
    },
    [plan.id],
  );
  useEffect(() => {
    if (editor && dirty) persistDraft(editor);
    if (!dirty && !busy) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const navigate = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target === '_blank' ||
        anchor.origin !== window.location.origin ||
        !dirty
      )
        return;
      if (!window.confirm('尚有未保存编辑，确定离开吗？当前草稿会保留在本浏览器。')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', navigate, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', navigate, true);
    };
  }, [editor, dirty, busy, persistDraft]);
  async function action(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function clearDraft() {
    try {
      sessionStorage.removeItem(draftKey(plan.id));
    } catch {
      /* The saved server version remains authoritative. */
    }
    setRetained(undefined);
  }
  function startGeneration(fields = selectedFields) {
    if (!mode || busy || inFlight.current || editing || unconfirmed) return;
    try {
      const safe = contentOptionsSchema.parse(options);
      if (!fields.length) throw new Error('请至少选择一项生成内容。');
      const request: ContentGenerationRequest = {
        planId: plan.id,
        expectedUpdatedAt: plan.updatedAt,
        options: safe,
        selectedFields: fields,
        requestId: crypto.randomUUID(),
        ...(pricing.inputUsdPerMillion !== undefined && pricing.outputUsdPerMillion !== undefined
          ? {
              pricing: {
                inputUsdPerMillion: pricing.inputUsdPerMillion,
                outputUsdPerMillion: pricing.outputUsdPerMillion,
              },
            }
          : {}),
      };
      setPending(request);
      if (mode === 'real') setDialog('authorize');
      else void runGeneration(request);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function runGeneration(request: ContentGenerationRequest, authorized = false) {
    if (inFlight.current || (mode === 'real' && !authorized)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setDialog(undefined);
    const recovery = { requestId: request.requestId, mode: mode ?? 'mock' };
    setRecoveryRequest(request);
    try {
      sessionStorage.setItem(
        requestKey(plan.id),
        JSON.stringify({ ...recovery, request: { ...request, authorizeReal: undefined } }),
      );
    } catch {
      setPreferenceMessage('请求记录暂存失败；若连接中断，请先检查历史版本和本机用量。');
    }
    try {
      const result = await generateContent({ ...request, authorizeReal: authorized });
      onUpdate(result.plan);
      setCompareId(version ? result.version.id : '');
      setMessage(
        version
          ? '新创意已保存为候选版本。当前采用内容和人工编辑保留，请比较后再采纳。'
          : '内容已生成并保存；可逐项编辑、复制或导出。',
      );
      try {
        sessionStorage.removeItem(requestKey(plan.id));
      } catch {
        /* No new external request is issued during cleanup. */
      }
      setUnconfirmed(undefined);
      setRecoveryRequest(undefined);
      setPending(undefined);
      void loadUsage();
    } catch (cause) {
      setError(`生成未完成：${errorMessage(cause)}。不会自动重试；请先检查已保存结果和用量。`);
      setUnconfirmed(recovery);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  async function recover() {
    await action(async () => {
      const fresh = await getContentPlan(plan.id);
      onUpdate(fresh);
      const found = fresh.versions.find(
        (item) => item.metadata?.requestId === unconfirmed?.requestId,
      );
      await loadUsage();
      if (found) {
        setCompareId(found.id);
        setUnconfirmed(undefined);
        try {
          sessionStorage.removeItem(requestKey(plan.id));
        } catch {
          /* Read-back completed without a new paid request. */
        }
        setMessage('找到上次已保存结果，没有重新调用 AI。');
      } else
        setMessage(
          '尚未找到上次请求的保存结果。请核对本机用量与服务商账单；连接中断不能证明没有计费。',
        );
    });
  }
  async function saveEditor() {
    if (!editor) return;
    await action(async () => {
      const output = toOutput(editor.draft);
      const fresh = await updateContentPlan(editor.baseline, { output });
      onUpdate(fresh);
      setEditor(undefined);
      clearDraft();
      setMessage('人工修改已保存为独立版本，原生成结果保留。');
    });
  }
  async function exportFile(format: 'markdown' | 'txt' | 'json' | 'zip', fields?: ContentField[]) {
    await action(async () => {
      await downloadContent(plan, format, fields ?? plan.templateSnapshot.outputFields);
      setMessage('导出已准备，请选择浏览器提示的保存位置。内容包不包含媒体文件。');
    });
  }
  function renderOutput(value: ContentVersion) {
    return (
      <div className="creation-output">
        {plan.templateSnapshot.outputFields.map((field) => (
          <section className="creation-result" key={field}>
            <div className="creation-result-header">
              <h3>{contentFieldLabels[field]}</h3>
              <div className="creation-actions">
                <CopyButton
                  value={value.output[field].join('\n\n')}
                  label={`复制${contentFieldLabels[field]}`}
                />
                <Button
                  variant="ghost"
                  disabled={busy || editing || Boolean(unconfirmed)}
                  onClick={() => startGeneration([field])}
                >
                  重新生成此项
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || editing}
                  onClick={() => void exportFile('txt', [field])}
                >
                  <Download size={13} />
                  导出此项
                </Button>
              </div>
            </div>
            {value.output[field].map((text, index) => (
              <p
                className={`creation-result-text${field === 'shortVideoScript' ? ' creation-script' : ''}`}
                key={index}
              >
                {text}
              </p>
            ))}
          </section>
        ))}
      </div>
    );
  }
  return (
    <>
      <section className="creation-panel">
        <div className="creation-panel-heading">
          <div>
            <h2>{plan.name}</h2>
            <p className="creation-note">{plan.productSnapshot.title}</p>
          </div>
          <Badge tone={mode === 'real' ? 'success' : 'warning'}>
            {mode === 'real'
              ? '服务：真实 AI'
              : mode === 'mock'
                ? '服务：Mock 本机演示'
                : '正在确认 AI 模式'}
          </Badge>
        </div>
        <div className="creation-actions">
          <Link href={`/products/${encodeURIComponent(plan.productId)}`} className="ws-text-link">
            ASIN {plan.productSnapshot.sourceId}
          </Link>
          <Badge>{plan.templateSnapshot.name}</Badge>
          {plan.comparisonSource && (
            <Link
              className="ws-text-link"
              href={`/comparisons?plan=${encodeURIComponent(plan.comparisonSource.id)}`}
            >
              引用：{plan.comparisonSource.name}
            </Link>
          )}
        </div>
        <p className="creation-note">
          商品采集时间 {new Date(plan.productSnapshot.updatedAt).toLocaleString('zh-CN')}
          ，是历史页面快照。卖点属于商家宣称，内容方向属于 AI
          推断；未分析评论正文，图片和视频不会自动上传。
        </p>
        {mode === 'mock' && (
          <p className="creation-notice">
            未配置真实 AI 时，生成内容使用本机 Mock 示例，不消耗外部 API，也不代表真实模型质量。可在
            Windows 启动器配置 API 地址、模型与 Key。
          </p>
        )}
        {mode === 'real' && (
          <p className="creation-note">
            每次生成前都需要你确认发送文字资料并承担可能产生的费用。不会自动重试或批量调用。
          </p>
        )}
        {modeError && <ErrorNotice message={modeError} onRetry={() => void loadMode()} />}
      </section>
      <ContentOptionsPanel
        options={options}
        pricing={pricing}
        disabled={busy || editing}
        message={preferenceMessage}
        onChange={setOptions}
        onPricing={setPricing}
        onSave={() => {
          try {
            localStorage.setItem(
              CONTENT_PREFERENCES_KEY,
              JSON.stringify({ version: 1, options: contentOptionsSchema.parse(options), pricing }),
            );
            setPreferenceMessage('创作偏好已保存。');
          } catch {
            setPreferenceMessage('参数无效或浏览器存储不可用，请检查时长与输入。');
          }
        }}
      />
      <section className="creation-panel">
        <div className="creation-panel-heading">
          <div>
            <h2>{version ? '当前采用内容' : '生成营销内容'}</h2>
            {version && (
              <p className="creation-note">
                {version.kind === 'edited'
                  ? '人工编辑版本'
                  : version.metadata?.mode === 'real'
                    ? '真实 AI 生成版本'
                    : 'Mock 示例版本'}{' '}
                · {new Date(version.createdAt).toLocaleString('zh-CN')}
              </p>
            )}
          </div>
          <div className="creation-actions">
            <Button
              disabled={busy || editing || !mode || Boolean(unconfirmed)}
              onClick={() => startGeneration()}
            >
              <Sparkles size={15} />
              {busy ? '正在处理…' : version ? '生成新创意版本' : '生成内容'}
            </Button>
            {version && (
              <Button
                variant="secondary"
                disabled={busy || editing || Boolean(retained)}
                onClick={() => setEditor({ draft: toDraft(version.output), baseline: plan })}
              >
                <Pencil size={14} />
                编辑内容
              </Button>
            )}
          </div>
        </div>
        <details style={{ marginBottom: 18 }}>
          <summary>选择本次生成内容 · {selectedFields.length} 项</summary>
          <div className="creation-checks" style={{ marginTop: 12 }}>
            {plan.templateSnapshot.outputFields.map((field) => (
              <label key={field}>
                <input
                  type="checkbox"
                  disabled={busy || editing}
                  checked={selectedFields.includes(field)}
                  onChange={(event) =>
                    setSelectedFields(
                      event.target.checked
                        ? [...selectedFields, field]
                        : selectedFields.filter((item) => item !== field),
                    )
                  }
                />
                {contentFieldLabels[field]}
              </label>
            ))}
          </div>
          <p className="creation-note">
            局部重新生成只合并选定项目，候选版本不会覆盖当前采用内容。仍可能请求完整结构，费用不保证更低。
          </p>
        </details>
        {error && <ErrorNotice message={error} />}
        {message && (
          <p role="status" className="creation-notice">
            {message}
          </p>
        )}
        {retained && !editor && (
          <div className="creation-notice">
            <p>
              发现本浏览器保留的编辑草稿。
              {retained.baselineUpdatedAt !== plan.updatedAt
                ? '服务器已有新版本，请先比较后保存；不会静默覆盖。'
                : ''}
            </p>
            <div className="creation-actions">
              <Button
                variant="secondary"
                disabled={busy || !version}
                onClick={() => {
                  if (
                    retained.baselineUpdatedAt !== plan.updatedAt &&
                    !window.confirm(
                      '服务器已有新版本。请先核对当前内容，是否明确在新版本上继续此保留草稿？保存会创建新历史版本。',
                    )
                  )
                    return;
                  setEditor({ draft: retained.draft, baseline: plan });
                  setRetained(undefined);
                }}
              >
                恢复本浏览器草稿
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('丢弃本浏览器保留的未保存草稿？服务器历史保持不变。'))
                    clearDraft();
                }}
              >
                丢弃本机草稿
              </Button>
            </div>
          </div>
        )}
        {unconfirmed && (
          <div className="creation-notice">
            <p>
              上次请求结果尚未确认。{unconfirmed.mode === 'real' ? '费用可能已产生。' : ''}
              先读取已保存结果，避免重复请求。
            </p>
            <div className="creation-actions">
              <Button variant="secondary" disabled={busy} onClick={() => void recover()}>
                检查上次结果与用量
              </Button>
              <Button
                variant="secondary"
                disabled={busy || !recoveryRequest || !mode}
                onClick={() => {
                  if (recoveryRequest) {
                    setPending(recoveryRequest);
                    if (mode === 'real') setDialog('authorize');
                    else void runGeneration(recoveryRequest);
                  }
                }}
              >
                恢复同一请求（不换编号）
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setDialog('abandon')}>
                已核对，允许新请求
              </Button>
            </div>
          </div>
        )}
        {editor ? (
          <div className="creation-output">
            <p className="creation-note">
              每条内容用独立一行「---」分隔。脚本保留 Hook / Problem / Solution / Demo /
              CTA；开场文案至少五条。
            </p>
            {plan.templateSnapshot.outputFields.map((field) => (
              <label className="creation-field" key={field}>
                {contentFieldLabels[field]}
                <textarea
                  aria-label={`编辑${contentFieldLabels[field]}`}
                  rows={field === 'shortVideoScript' ? 12 : 6}
                  value={editor.draft[field]}
                  disabled={busy}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      draft: { ...editor.draft, [field]: event.target.value },
                    })
                  }
                />
              </label>
            ))}
            <div className="creation-actions">
              <Button disabled={busy || !dirty} onClick={() => void saveEditor()}>
                <Save size={15} />
                保存人工修改
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (!dirty || window.confirm('关闭编辑？未保存修改保留在本浏览器。')) {
                    if (dirty) {
                      persistDraft(editor);
                      setRetained({
                        draft: editor.draft,
                        baselineUpdatedAt: editor.baseline.updatedAt,
                      });
                    }
                    setEditor(undefined);
                  }
                }}
              >
                取消编辑
              </Button>
            </div>
          </div>
        ) : version ? (
          <>
            <div className="creation-actions" style={{ marginBottom: 20 }}>
              <CopyButton
                value={exportContentTxt(plan, plan.templateSnapshot.outputFields)}
                label="复制整套内容"
              />
              {(['markdown', 'txt', 'json', 'zip'] as const).map((format) => (
                <Button
                  key={format}
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void exportFile(format)}
                >
                  <Download size={14} />
                  {format === 'zip'
                    ? '导出内容包 ZIP'
                    : `导出 ${format === 'markdown' ? 'Markdown' : format.toUpperCase()}`}
                </Button>
              ))}
            </div>
            {renderOutput(version)}
          </>
        ) : (
          <EmptyState
            title="准备好第一份内容草稿"
            description="确认商品和模板后点击生成内容。不会自动发起收费请求。"
          />
        )}
      </section>
      {version?.metadata && (
        <details className="creation-panel">
          <summary>来源边界与文本时长检查</summary>
          <p className="creation-note">
            目标 {version.metadata.textDurationEstimate.requestedSeconds} 秒，口播文本估算{' '}
            {version.metadata.textDurationEstimate.estimatedSeconds} 秒。
          </p>
          {version.metadata.textDurationEstimate.warnings.map((warning) => (
            <p key={warning} className="creation-note">
              {warning}
            </p>
          ))}
          {(['facts', 'merchantClaims', 'inferences', 'unknowns'] as const).map((field) => (
            <section key={field} style={{ marginTop: 18 }}>
              <h3>
                {
                  (
                    {
                      facts: '页面采集事实',
                      merchantClaims: '商家自行宣称',
                      inferences: 'AI 推断',
                      unknowns: '未知与待核实',
                    } as const
                  )[field]
                }
              </h3>
              <ul className="creation-note">
                {version.metadata!.evidence[field].map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </section>
          ))}
        </details>
      )}
      {plan.versions.length > 0 && (
        <details className="creation-panel" open={Boolean(compareId)}>
          <summary>
            <History size={15} style={{ display: 'inline', verticalAlign: 'middle' }} />{' '}
            <span>历史版本与比较</span> · {plan.versions.length} 个版本
          </summary>
          <label className="creation-field" style={{ marginTop: 15 }}>
            比较版本
            <select
              aria-label="比较内容版本"
              value={compareId}
              onChange={(event) => setCompareId(event.target.value)}
            >
              <option value="">选择候选或历史版本</option>
              {[...plan.versions].reverse().map((item, index) => (
                <option key={item.id} value={item.id}>
                  版本 {plan.versions.length - index} ·{' '}
                  {item.kind === 'edited'
                    ? '人工编辑'
                    : item.kind === 'restored'
                      ? '历史恢复'
                      : item.metadata?.mode === 'real'
                        ? '真实 AI'
                        : 'Mock'}
                  {item.id === plan.currentVersionId ? ' · 当前采用' : ''}
                </option>
              ))}
            </select>
          </label>
          {compared && version && (
            <>
              <div className="creation-actions" style={{ margin: '14px 0' }}>
                <Button
                  variant="secondary"
                  disabled={busy || editing || compared.id === plan.currentVersionId}
                  onClick={() => {
                    setVersionId(compared.id);
                    setDialog('adopt');
                  }}
                >
                  采纳此版本
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || editing}
                  onClick={() => {
                    setVersionId(compared.id);
                    setDialog('restore');
                  }}
                >
                  恢复此版本
                </Button>
                <CopyButton
                  value={exportContentTxt(plan, CONTENT_FIELDS, compared.id)}
                  label="复制比较版本"
                />
              </div>
              <div className="creation-comparison">
                <div>
                  <h3>当前采用</h3>
                  {plan.templateSnapshot.outputFields.map((field) => (
                    <section key={field}>
                      <h4>{contentFieldLabels[field]}</h4>
                      <p>{version.output[field].join('\n\n')}</p>
                    </section>
                  ))}
                </div>
                <div>
                  <h3>选定版本</h3>
                  {plan.templateSnapshot.outputFields.map((field) => (
                    <section key={field}>
                      <h4>
                        {contentFieldLabels[field]}
                        {JSON.stringify(version.output[field]) !==
                        JSON.stringify(compared.output[field])
                          ? ' · 有差异'
                          : ''}
                      </h4>
                      <p>{compared.output[field].join('\n\n')}</p>
                    </section>
                  ))}
                </div>
              </div>
            </>
          )}
          <p className="creation-note">
            历史版本最多 50 个，达到上限后停止写入，不会自动删除你的编辑。
          </p>
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
              ? '授权本次真实 AI 请求'
              : dialog === 'abandon'
                ? '确认已经核对上次请求'
                : dialog === 'adopt'
                  ? '采纳候选版本'
                  : '恢复历史版本'
          }
          busy={busy}
          onClose={() => setDialog(undefined)}
        >
          <p className="creation-note">
            {dialog === 'authorize'
              ? '将商品文字、模板指令、生成参数与可选对比结论发送至你配置的服务商，可能消耗 API 额度。不会上传图片和视频，不会自动重试。'
              : dialog === 'abandon'
                ? '新请求可能再次产生费用。请先核对保存历史、本机用量与服务商账单；未知结果不能当作免费。'
                : dialog === 'adopt'
                  ? '此操作只切换当前采用版本，原内容和人工编辑继续保留在历史中。'
                  : '历史内容将另存为新的恢复版本；原生成结果和人工编辑全部保留。'}
          </p>
          {dialog === 'authorize' && (
            <p className="creation-note">
              {pending?.pricing
                ? `你填写的输入 / 输出单价：$${pending.pricing.inputUsdPerMillion} / $${pending.pricing.outputUsdPerMillion}（每百万 Token）。实际用量尚未知。`
                : '未设置完整单价，费用未知；继续不代表免费。'}
            </p>
          )}
          {candidate && (dialog === 'restore' || dialog === 'adopt') && (
            <p className="creation-note">
              选定内容时间：{new Date(candidate.createdAt).toLocaleString('zh-CN')}
            </p>
          )}
          <div className="creation-actions" style={{ marginTop: 20 }}>
            <Button
              disabled={busy}
              onClick={() => {
                if (dialog === 'authorize' && pending) void runGeneration(pending, true);
                else if (dialog === 'abandon') {
                  setUnconfirmed(undefined);
                  try {
                    sessionStorage.removeItem(requestKey(plan.id));
                  } catch {
                    /* Explicit user acknowledgment does not perform a paid operation. */
                  }
                  setDialog(undefined);
                } else if (versionId)
                  void action(async () => {
                    onUpdate(
                      await updateContentPlan(
                        plan,
                        dialog === 'adopt'
                          ? { adoptVersionId: versionId }
                          : { restoreVersionId: versionId },
                      ),
                    );
                    setDialog(undefined);
                    setMessage('当前采用内容已更新，历史版本保留。');
                  });
              }}
            >
              {dialog === 'authorize'
                ? '授权并生成一次'
                : dialog === 'adopt'
                  ? '确认采纳'
                  : dialog === 'restore'
                    ? '确认恢复'
                    : '已核对，允许新请求'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setDialog(undefined)}>
              取消
            </Button>
          </div>
        </LibraryDialog>
      )}
    </>
  );
}
