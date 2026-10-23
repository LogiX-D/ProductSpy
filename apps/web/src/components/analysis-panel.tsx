'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, Loader2, Pencil, Save, Sparkles, X } from 'lucide-react';
import {
  ApiRequestError,
  analysisSchema,
  analysisMetadataSchema,
  errorMessage,
  productSchema,
  type AnalysisField,
  type AnalysisGenerationResponse,
  type AnalysisOptions,
  type AnalysisUsageReport,
  type AnalysisPricing,
  type Product,
  type ProductAnalysis,
} from '@productspy/shared';
import { productRepository } from '../lib/storage/product-api';
import { getAccountSession, isLegacyMode, webRequest } from '../lib/session';
import { analysisCopy } from './analysis-copy';
import { AnalysisEditor } from './analysis-editor';
import { AnalysisOptionsPanel } from './analysis-options';
import { AnalysisHistory, analysisProvenance } from './analysis-history';
import { HistoryManager } from './history-manager';
import { AnalysisEvidence } from './analysis-evidence';
import { AnalysisUsagePanel } from './analysis-usage';
import { analysisFieldLabels, downloadAnalysis } from './analysis-export';
import {
  ANALYSIS_PREFERENCES_KEY,
  DEFAULT_ANALYSIS_OPTIONS,
  analysisOptionsSummary,
  restoreAnalysisPreferences,
  type AnalysisPricingPreference,
} from './analysis-preferences';
import {
  analysisAllText,
  analysisSectionText,
  analysisSections,
  createAnalysisDraft,
  draftToAnalysis,
  isMockAnalysis,
  parseScript,
  restoreSessionDraft,
  sessionDraftKey,
  sessionDraftMaxCharacters,
  validateAnalysisDraft,
  type AnalysisDraft,
  type AnalysisSectionId,
  type AnalysisSessionDraft,
} from './analysis-utils';
import { Badge, Button, CopyButton, EmptyState, ErrorNotice } from './ui';
import {
  AIChannelSelector,
  aiSelectionInput,
  useAIChannels,
  type PreparedAISelection,
} from './ai-channel-selector';

export { parseScript } from './analysis-utils';

// This tab's in-memory fallback protects app tab switches if browser storage is unavailable.
const volatileDrafts = new Map<string, AnalysisSessionDraft>();

function InsightList({ items, copyItems = false }: { items: string[]; copyItems?: boolean }) {
  return (
    <ul className={`analysis-insights ${copyItems ? 'analysis-copy-items' : ''}`}>
      {items.map((item, index) => (
        <li key={index}>
          <p>{item}</p>
          {copyItems && <CopyButton value={item} label={analysisCopy.copyItem} />}
        </li>
      ))}
    </ul>
  );
}

function AnalysisBlock({
  id,
  analysis,
  children,
  wide = false,
}: {
  id: AnalysisSectionId;
  analysis: ProductAnalysis;
  children: ReactNode;
  wide?: boolean;
}) {
  const label = analysisSections.find((section) => section.id === id)!.label;
  return (
    <section
      id={`analysis-${id}`}
      className={`analysis-block ${wide ? 'analysis-block-wide' : ''}`}
      tabIndex={-1}
    >
      <div className="analysis-block-heading">
        <h2>{label}</h2>
        <CopyButton value={analysisSectionText(analysis, id)} label={analysisCopy.copySection} />
      </div>
      {children}
    </section>
  );
}

function AnalysisReader({ analysis }: { analysis: ProductAnalysis }) {
  return (
    <div className="analysis-content-grid">
      <AnalysisBlock id="summary" analysis={analysis} wide>
        <p className="analysis-summary-text">{analysis.summary}</p>
      </AnalysisBlock>
      <AnalysisBlock id="sellingPoints" analysis={analysis}>
        <InsightList items={analysis.sellingPoints} />
      </AnalysisBlock>
      <AnalysisBlock id="marketingAngles" analysis={analysis}>
        <InsightList items={analysis.marketingAngles} />
      </AnalysisBlock>
      <AnalysisBlock id="audience" analysis={analysis}>
        <h3>{analysisCopy.targetAudience}</h3>
        <InsightList items={analysis.targetAudience} />
        <h3>{analysisCopy.purchaseMotivations}</h3>
        <InsightList items={analysis.purchaseMotivations} />
        <h3>{analysisCopy.painPoints}</h3>
        <InsightList items={analysis.painPoints} />
      </AnalysisBlock>
      <AnalysisBlock id="strengths" analysis={analysis}>
        <h3>{analysisCopy.strengths}</h3>
        <InsightList items={analysis.strengths} />
        <h3>{analysisCopy.weaknesses}</h3>
        <InsightList items={analysis.weaknesses} />
      </AnalysisBlock>
      <AnalysisBlock id="hooks" analysis={analysis} wide>
        <InsightList items={analysis.hooks} copyItems />
      </AnalysisBlock>
      <AnalysisBlock id="shortVideoScript" analysis={analysis} wide>
        <div className="analysis-script">
          {parseScript(analysis.shortVideoScript).map((step, index) => (
            <div className="analysis-script-step" key={index}>
              <h3>{step.label}</h3>
              <p>{step.content}</p>
            </div>
          ))}
        </div>
      </AnalysisBlock>
      <AnalysisBlock id="imagePrompts" analysis={analysis}>
        <InsightList items={analysis.imagePrompts} copyItems />
      </AnalysisBlock>
      <AnalysisBlock id="videoPrompts" analysis={analysis}>
        <InsightList items={analysis.videoPrompts} copyItems />
      </AnalysisBlock>
    </div>
  );
}

type EditorState = {
  draft: AnalysisDraft;
  initialDraft: AnalysisDraft;
  baselineUpdatedAt: string;
  isMock: boolean;
  mockPrefix: string;
};
type GenerationPlan = {
  ai: PreparedAISelection;
  requestId: string;
  product: Product;
  options: AnalysisOptions;
  fields?: AnalysisField[];
  pricing?: AnalysisPricing;
};
type UnconfirmedRequest = { requestId: string; mode: 'mock' | 'real'; createdAt: string };
const requestRecoveryKey = (productId: string) => `productspy:analysis-request:v1:${productId}`;

function AnalysisContent({
  product,
  onUpdate,
}: {
  product: Product;
  onUpdate: (product: Product) => void;
}) {
  const channels = useAIChannels();
  const mode = channels.mode;
  const privateDraftId = isLegacyMode
    ? product.id
    : `${getAccountSession()?.user.id ?? 'unverified'}:${product.id}`;
  const modeFailed = Boolean(channels.error);
  const [options, setOptions] = useState<AnalysisOptions>({ ...DEFAULT_ANALYSIS_OPTIONS });
  const [pricing, setPricing] = useState<AnalysisPricingPreference>({});
  const [fields, setFields] = useState<AnalysisField[]>(
    Object.keys(analysisFieldLabels) as AnalysisField[],
  );
  const [preferenceMessage, setPreferenceMessage] = useState('');
  const [pendingGeneration, setPendingGeneration] = useState<GenerationPlan>();
  const [usageReport, setUsageReport] = useState<AnalysisUsageReport>();
  const [usageError, setUsageError] = useState('');
  const [usageLoading, setUsageLoading] = useState(false);
  const [unconfirmedRequest, setUnconfirmedRequest] = useState<UnconfirmedRequest>();
  const [checkingResult, setCheckingResult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [validation, setValidation] = useState<string[]>([]);
  const [generated, setGenerated] = useState<{
    analysis: ProductAnalysis;
    baselineUpdatedAt: string;
  }>();
  const [editor, setEditor] = useState<EditorState>();
  const [retained, setRetained] = useState<AnalysisSessionDraft>();
  const [storageFailed, setStorageFailed] = useState(false);
  const [dialog, setDialog] = useState<'close' | 'regenerate' | 'discard' | 'authorize'>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const validationRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const generationInFlight = useRef(false);
  const analysis =
    generated?.baselineUpdatedAt === product.updatedAt ? generated.analysis : product.aiAnalysis;
  const isMock =
    editor?.isMock ??
    (product.analysisMetadata
      ? product.analysisMetadata.mode === 'mock'
      : analysis
        ? isMockAnalysis(analysis.summary)
        : mode === 'mock');
  const mixedGeneration = Boolean(
    product.analysisMetadata?.selectedFields &&
    product.analysisMetadata.selectedFields.length < Object.keys(analysisFieldLabels).length,
  );
  const dirty = Boolean(
    editor &&
    (editor.baselineUpdatedAt !== product.updatedAt ||
      JSON.stringify(editor.draft) !== JSON.stringify(editor.initialDraft)),
  );
  const controlsDisabled = busy || saving || checkingResult;

  async function checkMode() {
    await channels.reload();
  }

  async function loadUsage() {
    setUsageLoading(true);
    try {
      const report = await webRequest<AnalysisUsageReport>('/api/analysis-usage');
      if (mounted.current) {
        setUsageReport(report);
        setUsageError('');
      }
    } catch (reason: unknown) {
      if (mounted.current) setUsageError(`用量读取失败：${errorMessage(reason)}`);
    } finally {
      if (mounted.current) setUsageLoading(false);
    }
  }

  useEffect(() => {
    try {
      const restored = restoreAnalysisPreferences(localStorage.getItem(ANALYSIS_PREFERENCES_KEY));
      setOptions(restored.options);
      setPricing(restored.pricing);
    } catch {
      setPreferenceMessage('浏览器偏好存储不可用。本次设置仍可使用。');
    }
    try {
      const raw = sessionStorage.getItem(requestRecoveryKey(product.id));
      if (raw && raw.length < 1000) {
        const value: unknown = JSON.parse(raw);
        if (
          value &&
          typeof value === 'object' &&
          'requestId' in value &&
          typeof value.requestId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId) &&
          'mode' in value &&
          (value.mode === 'mock' || value.mode === 'real') &&
          'createdAt' in value &&
          typeof value.createdAt === 'string' &&
          Number.isFinite(Date.parse(value.createdAt))
        ) {
          setUnconfirmedRequest({
            requestId: value.requestId,
            mode: value.mode,
            createdAt: value.createdAt,
          });
        }
      }
    } catch {
      /* Recovery still works in memory if browser storage is unavailable. */
    }
    void loadUsage();
  }, [product.id]);

  function savePreferences() {
    try {
      const safe = restoreAnalysisPreferences(JSON.stringify({ version: 1, options, pricing }));
      localStorage.setItem(ANALYSIS_PREFERENCES_KEY, JSON.stringify(safe));
      setPreferenceMessage('已保存到本浏览器。');
    } catch {
      setPreferenceMessage('保存偏好失败。本次设置仍可使用，请检查浏览器存储权限。');
    }
  }

  useEffect(() => {
    if (!error) return;
    errorRef.current?.focus({ preventScroll: true });
    errorRef.current?.scrollIntoView({ block: 'center' });
  }, [error]);

  useEffect(() => {
    if (!validation.length) return;
    validationRef.current?.focus({ preventScroll: true });
    validationRef.current?.scrollIntoView({ block: 'center' });
  }, [validation]);

  useEffect(() => {
    mounted.current = true;
    const volatile = volatileDrafts.get(privateDraftId);
    if (volatile) {
      setRetained(volatile);
      setStorageFailed(true);
    }
    try {
      const restored = restoreSessionDraft(
        sessionStorage.getItem(sessionDraftKey(product.id)),
        product.id,
        product.updatedAt,
      );
      if (restored && !volatile) setRetained(restored.session);
    } catch {
      setStorageFailed(true);
    }
    return () => {
      mounted.current = false;
    };
  }, [product.id, product.updatedAt, privateDraftId]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  useEffect(() => {
    const element = dialogRef.current;
    if (dialog && element && !element.open) element.showModal();
  }, [dialog]);

  function hideDialog() {
    dialogRef.current?.close();
    setDialog(undefined);
  }

  function clearDraft(expectedSerialized?: string | null) {
    try {
      const volatile = volatileDrafts.get(privateDraftId);
      if (
        expectedSerialized !== undefined &&
        (volatile
          ? JSON.stringify(volatile)
          : sessionStorage.getItem(sessionDraftKey(product.id))) !== expectedSerialized
      )
        return;
      volatileDrafts.delete(privateDraftId);
      sessionStorage.removeItem(sessionDraftKey(product.id));
    } catch {
      if (mounted.current) setStorageFailed(true);
    }
    if (mounted.current) setRetained(undefined);
  }

  function persistDraft(next: EditorState): boolean {
    const session: AnalysisSessionDraft = {
      version: 1,
      productId: product.id,
      baselineUpdatedAt: next.baselineUpdatedAt,
      savedAt: new Date().toISOString(),
      isMock: next.isMock,
      draft: next.draft,
    };
    const keepVolatile = () => {
      volatileDrafts.set(privateDraftId, session);
      setRetained(session);
      setStorageFailed(true);
      return false;
    };
    try {
      const serialized = JSON.stringify(session);
      if (serialized.length > sessionDraftMaxCharacters) return keepVolatile();
      sessionStorage.setItem(sessionDraftKey(product.id), serialized);
      volatileDrafts.delete(privateDraftId);
      setRetained(session);
      setStorageFailed(false);
      return true;
    } catch {
      return keepVolatile();
    }
  }

  function changeDraft(draft: AnalysisDraft) {
    if (!editor) return;
    const next = { ...editor, draft };
    setEditor(next);
    setValidation([]);
    setMessage('');
    if (
      next.baselineUpdatedAt !== product.updatedAt ||
      JSON.stringify(draft) !== JSON.stringify(next.initialDraft)
    )
      persistDraft(next);
    else clearDraft();
  }

  function beginEdit(restore = false) {
    const session = restore ? retained : undefined;
    if (!analysis && !session) return;
    const initialDraft = analysis ? createAnalysisDraft(analysis) : session!.draft;
    setEditor({
      draft: session?.draft ?? initialDraft,
      initialDraft,
      baselineUpdatedAt: session?.baselineUpdatedAt ?? product.updatedAt,
      isMock: session?.isMock ?? isMock,
      mockPrefix:
        product.analysisMetadata?.options.language === 'en' ||
        /^Mock demo/i.test(analysis?.summary ?? session?.draft.summary ?? '')
          ? 'Mock demo analysis (manually edited): '
          : product.analysisMetadata?.options.language === 'ja' ||
              /^Mock デモ/i.test(analysis?.summary ?? session?.draft.summary ?? '')
            ? 'Mock デモ分析（手動編集）：'
            : analysisCopy.mockSummaryPrefix,
    });
    setError('');
    setValidation([]);
    setMessage(session ? analysisCopy.restoredDraft : '');
  }

  async function saveEdit(): Promise<boolean> {
    if (!editor || controlsDisabled) return false;
    const errors = validateAnalysisDraft(editor.draft, editor.isMock);
    setValidation(errors);
    if (errors.length) {
      hideDialog();
      return false;
    }
    setSaving(true);
    setError('');
    const draftAtStart = retained ? JSON.stringify(retained) : null;
    try {
      const updated = await productRepository.saveAnalysis(
        product.id,
        analysisSchema.parse(draftToAnalysis(editor.draft, editor.isMock, editor.mockPrefix)),
        editor.baselineUpdatedAt,
      );
      clearDraft(draftAtStart);
      onUpdate(updated);
      if (mounted.current) {
        setGenerated(undefined);
        setEditor(undefined);
        hideDialog();
        setMessage(analysisCopy.saved);
      }
      return true;
    } catch (reason: unknown) {
      if (mounted.current) {
        persistDraft(editor);
        setError(
          reason instanceof ApiRequestError && reason.status === 409
            ? analysisCopy.conflict
            : `${analysisCopy.saveFailed} ${errorMessage(reason)}`,
        );
        hideDialog();
      }
      return false;
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  function prepareGeneration() {
    if (controlsDisabled || !mode) return;
    const ai = channels.freeze();
    if (!ai) return;
    if (analysis && fields.length === 0) {
      setError('请在分析设置中选择至少一项重新生成的内容。');
      return;
    }
    const plan: GenerationPlan = {
      ai,
      requestId: crypto.randomUUID(),
      product,
      options: { ...options },
      fields: analysis ? [...fields] : undefined,
      pricing:
        pricing.inputUsdPerMillion !== undefined && pricing.outputUsdPerMillion !== undefined
          ? {
              inputUsdPerMillion: pricing.inputUsdPerMillion,
              outputUsdPerMillion: pricing.outputUsdPerMillion,
            }
          : undefined,
    };
    setPendingGeneration(plan);
    if (analysis || retained || editor || unconfirmedRequest) setDialog('regenerate');
    else if (plan.ai.mode === 'real') setDialog('authorize');
    else void analyze(plan);
  }

  function confirmGeneration() {
    if (!pendingGeneration || controlsDisabled) return;
    if (editor && dirty) persistDraft(editor);
    if (pendingGeneration.ai.mode === 'real') setDialog('authorize');
    else void analyze(pendingGeneration);
  }

  async function analyze(plan: GenerationPlan, authorizeReal = false) {
    if (controlsDisabled || generationInFlight.current) return;
    if (!channels.isCurrent(plan.ai)) {
      setError('账号已切换，请重新选择渠道并发起请求。');
      hideDialog();
      return;
    }
    if (plan.ai.mode === 'real' && !authorizeReal) return;
    generationInFlight.current = true;
    hideDialog();
    setBusy(true);
    setError('');
    setMessage('');
    const attemptedRequest: UnconfirmedRequest = {
      requestId: plan.requestId,
      mode: plan.ai.mode,
      createdAt: new Date().toISOString(),
    };
    try {
      sessionStorage.setItem(requestRecoveryKey(product.id), JSON.stringify(attemptedRequest));
    } catch {
      /* Never retry an AI call because local bookkeeping failed. */
    }
    try {
      // Existing analyses and history never enter the prompt or the request body.
      const {
        aiAnalysis: _analysis,
        analysisMetadata: _metadata,
        analysisHistory: _history,
        ...sourceProduct
      } = plan.product;
      void _analysis;
      void _metadata;
      void _history;
      const data = await webRequest<unknown>('/api/analyze-product', {
        method: 'POST',
        body: JSON.stringify({
          product: sourceProduct,
          options: plan.options,
          fields: plan.fields,
          pricing: plan.pricing,
          requestId: plan.requestId,
          authorizeReal,
          ...aiSelectionInput(plan.ai),
        }),
        signal: AbortSignal.timeout(130000),
      });
      if (
        !data ||
        typeof data !== 'object' ||
        !('product' in data) ||
        !('analysis' in data) ||
        !('metadata' in data)
      )
        throw new Error('AI 服务返回的响应结构不完整。');
      const response = data as AnalysisGenerationResponse;
      const result = analysisSchema.parse(response.analysis);
      const updated = productSchema.parse(response.product);
      analysisMetadataSchema.parse(response.metadata);
      try {
        sessionStorage.removeItem(requestRecoveryKey(product.id));
      } catch {
        /* In-memory confirmation remains available. */
      }
      if (mounted.current) {
        setUnconfirmedRequest(undefined);
        setGenerated({ analysis: result, baselineUpdatedAt: updated.updatedAt });
        setEditor(undefined);
        setValidation([]);
        setMessage(
          retained || (editor && dirty)
            ? '新结果已保存，原已保存版本可在历史中恢复。未保存草稿仍保留，可导出或手工合并。'
            : '分析已保存。原已保存结果可在版本记录中比较与恢复。',
        );
      }
      onUpdate(updated);
    } catch (reason: unknown) {
      if (mounted.current) {
        setUnconfirmedRequest(attemptedRequest);
        setError(
          reason instanceof ApiRequestError && reason.status === 409
            ? analysisCopy.analyzeConflict
            : `${analysisCopy.analyzeFailed} ${errorMessage(reason)}`,
        );
      }
    } finally {
      generationInFlight.current = false;
      if (mounted.current) setBusy(false);
      void loadUsage();
    }
  }

  async function checkPreviousResult() {
    if (!unconfirmedRequest || controlsDisabled) return;
    setCheckingResult(true);
    setError('');
    try {
      const [saved, usage] = await Promise.allSettled([
        productRepository.get(product.id),
        webRequest<AnalysisUsageReport>('/api/analysis-usage'),
      ]);
      if (!mounted.current) return;
      if (usage.status === 'fulfilled') {
        setUsageReport(usage.value);
        setUsageError('');
      }
      if (saved.status === 'rejected') throw saved.reason;
      if (!saved.value) throw new Error('未能读取商品当前结果。');
      const updated = saved.value;
      const recorded =
        updated.analysisMetadata?.requestId === unconfirmedRequest.requestId ||
        updated.analysisHistory?.some(
          (version) => version.metadata?.requestId === unconfirmedRequest.requestId,
        );
      if (recorded) {
        if (editor && dirty) persistDraft(editor);
        // A later manual edit may already exist. Always display the current saved product.
        setGenerated(undefined);
        setEditor(undefined);
        onUpdate(updated);
        setUnconfirmedRequest(undefined);
        try {
          sessionStorage.removeItem(requestRecoveryKey(product.id));
        } catch {
          /* No request is issued during recovery. */
        }
        setMessage(
          '已找到上次请求的保存记录。现在显示商品当前分析，后续编辑与版本均保留；此次检查没有调用 AI。',
        );
      } else {
        const entry =
          usage.status === 'fulfilled'
            ? usage.value.records.find(
                (record) => record.requestId === unconfirmedRequest.requestId,
              )
            : undefined;
        setMessage(
          entry
            ? `上次请求状态：${({ started: '结果尚未确认', succeeded: '已完成，但商品中未找到对应保存版本', failed: '失败', conflict: '保存时发生版本冲突' } as const)[entry.status]}。未发起新的 AI 请求。${unconfirmedRequest.mode === 'real' ? '费用可能已产生；请核对请求用量与服务商账单，勿把结果未知视为免费。' : ''}`
            : `尚未找到上次请求的保存记录。未发起新的 AI 请求。${unconfirmedRequest.mode === 'real' ? '网络中断或超时不能证明服务商没有计费，请先核对账单，再决定是否重新生成。' : ''}`,
        );
      }
    } catch (reason: unknown) {
      if (mounted.current)
        setError(`检查上次结果失败：${errorMessage(reason)}。没有发起 AI 请求。`);
    } finally {
      if (mounted.current) setCheckingResult(false);
    }
  }

  async function restoreVersion(versionId: string) {
    if (controlsDisabled) return;
    if (editor && dirty) persistDraft(editor);
    setSaving(true);
    setError('');
    try {
      const updated = await productRepository.restoreAnalysis(
        product.id,
        versionId,
        product.updatedAt,
      );
      onUpdate(updated);
      setGenerated(undefined);
      setEditor(undefined);
      setMessage('历史分析已恢复为新版本。原版本与本标签页未保存草稿仍保留。');
    } catch (reason: unknown) {
      setError(
        reason instanceof ApiRequestError && reason.status === 409
          ? '恢复冲突：商品已在其他页面更新。没有覆盖新内容，请刷新商品后重试。'
          : `恢复失败：${errorMessage(reason)}`,
      );
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  function exportResult(format: 'md' | 'txt') {
    const value = editor
      ? draftToAnalysis(editor.draft, editor.isMock, editor.mockPrefix)
      : analysis;
    if (!value) return;
    try {
      downloadAnalysis(
        product,
        value,
        format,
        `${editor ? '未保存的人工编辑草稿。\n' : ''}${analysisProvenance(product.analysisMetadata)}`,
      );
      setMessage(`${format === 'md' ? 'Markdown' : 'TXT'} 文件已在本机生成，未发送给第三方。`);
    } catch (reason: unknown) {
      setError(`导出失败：${errorMessage(reason)}`);
    }
  }

  function closeEditor() {
    if (dirty) setDialog('close');
    else {
      setEditor(undefined);
      setValidation([]);
    }
  }
  function closeDialog() {
    if (!controlsDisabled) hideDialog();
  }

  return (
    <div className="analysis-workspace" aria-busy={controlsDisabled}>
      <div className="analysis-workspace-header">
        <div>
          <div className="analysis-title-line">
            <h2>{analysisCopy.title}</h2>
            {(isMock || mode) && (
              <Badge tone={isMock || mode === 'mock' ? 'warning' : 'success'}>
                {isMock
                  ? analysisCopy.mockBadge
                  : mode === 'mock'
                    ? analysisCopy.mockModeBadge
                    : analysisCopy.realBadge}
              </Badge>
            )}
          </div>
          <p>{analysisCopy.intro}</p>
          {isMock && <p className="analysis-mode-note">{analysisCopy.mockNotice}</p>}
          {mixedGeneration && (
            <p className="analysis-mode-note">
              当前结果包含局部更新：本次参数和来源仅应用所选内容，其余内容保留原版本。具体范围见事实依据与版本记录。
            </p>
          )}
          {mode === 'real' && <p className="analysis-mode-note">{analysisCopy.realNotice}</p>}
          {mode === 'mock' && !isMock && (
            <p className="analysis-mode-note">{analysisCopy.mockGenerationNotice}</p>
          )}
        </div>
        <div className="analysis-header-actions">
          {analysis && !editor && (
            <Button
              variant="secondary"
              onClick={() => beginEdit()}
              disabled={controlsDisabled || Boolean(retained)}
            >
              <Pencil size={15} />
              {analysisCopy.edit}
            </Button>
          )}
          <Button onClick={prepareGeneration} disabled={controlsDisabled || !mode}>
            {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
            {busy
              ? analysisCopy.generating
              : analysis
                ? analysisCopy.regenerate
                : analysisCopy.start}
          </Button>
        </div>
      </div>
      <AIChannelSelector controller={channels} disabled={controlsDisabled} />
      {isLegacyMode && modeFailed && (
        <ErrorNotice
          message="无法确认工作台的 AI 模式，暂未发起生成。已保存的内容仍可编辑与导出。"
          onRetry={() => void checkMode()}
        />
      )}
      <AnalysisOptionsPanel
        options={options}
        pricing={pricing}
        fields={fields}
        hasAnalysis={Boolean(analysis)}
        disabled={controlsDisabled}
        message={preferenceMessage}
        onOptions={setOptions}
        onPricing={setPricing}
        onFields={setFields}
        onSave={savePreferences}
      />
      {error && (
        <div className="analysis-error-summary" ref={errorRef} tabIndex={-1}>
          <ErrorNotice message={error} />
        </div>
      )}
      {unconfirmedRequest && (
        <div className="analysis-draft-notice" role="status">
          <div>
            <strong>上次请求结果尚未确认</strong>
            <p>
              {unconfirmedRequest.mode === 'real'
                ? '网络中断或超时后，服务商仍可能已生成并计费。先检查已保存结果和用量；不会自动重新发送。'
                : '请先检查上次请求是否已保存，不会自动重新生成。'}
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={controlsDisabled}
            onClick={() => void checkPreviousResult()}
          >
            {checkingResult ? '正在检查…' : '检查上次请求结果'}
          </Button>
        </div>
      )}
      {message && (
        <p className="analysis-feedback" role="status">
          {message}
        </p>
      )}
      {!editor && retained && (
        <div className="analysis-draft-notice" role="status">
          <div>
            <strong>{analysisCopy.retainedDraft}</strong>
            <p>
              {retained.baselineUpdatedAt !== product.updatedAt
                ? analysisCopy.staleDraft
                : analysisCopy.sessionHint}
            </p>
          </div>
          <div className="analysis-inline-actions">
            <Button variant="secondary" onClick={() => beginEdit(true)} disabled={controlsDisabled}>
              {analysisCopy.restore}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setDialog('discard')}
              disabled={controlsDisabled}
            >
              {analysisCopy.discard}
            </Button>
          </div>
        </div>
      )}
      {!analysis && !editor ? (
        <EmptyState
          title={busy ? analysisCopy.busyTitle : analysisCopy.emptyTitle}
          description={busy ? analysisCopy.busyDescription : analysisCopy.emptyDescription}
        />
      ) : (
        <>
          <div className="analysis-action-bar">
            {editor ? (
              <>
                <div>
                  <strong>{analysisCopy.edit}</strong>
                  <p>{analysisCopy.editorIntro}</p>
                </div>
                <div className="analysis-inline-actions">
                  <CopyButton
                    value={analysisAllText(
                      draftToAnalysis(editor.draft, editor.isMock, editor.mockPrefix),
                      editor.isMock,
                    )}
                    label={analysisCopy.copyDraft}
                  />
                  <Button variant="secondary" onClick={closeEditor} disabled={controlsDisabled}>
                    <X size={15} />
                    {analysisCopy.closeEdit}
                  </Button>
                  <Button onClick={() => void saveEdit()} disabled={controlsDisabled}>
                    <Save size={15} />
                    {saving ? analysisCopy.saving : analysisCopy.save}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p>
                  {analysisSections.length} {analysisCopy.sectionCountHint}
                </p>
                <div className="analysis-inline-actions">
                  <CopyButton
                    value={analysisAllText(analysis!, isMock)}
                    label={analysisCopy.copyAll}
                  />
                </div>
              </>
            )}
            <div className="analysis-inline-actions analysis-export-actions">
              <Button
                variant="ghost"
                onClick={() => exportResult('md')}
                disabled={controlsDisabled}
              >
                <Download size={14} />
                导出 Markdown
              </Button>
              <Button
                variant="ghost"
                onClick={() => exportResult('txt')}
                disabled={controlsDisabled}
              >
                导出 TXT
              </Button>
            </div>
          </div>
          {!editor && <AnalysisEvidence metadata={product.analysisMetadata} />}
          {editor && (
            <p
              className={`analysis-editor-status ${storageFailed ? 'analysis-storage-warning' : ''}`}
              role="status"
            >
              {dirty ? analysisCopy.unsaved : analysisCopy.unchanged} ·{' '}
              {storageFailed
                ? analysisCopy.sessionFailed
                : dirty
                  ? analysisCopy.sessionSaved
                  : analysisCopy.sessionHint}
              {editor.isMock && <span>{analysisCopy.mockEditNotice}</span>}
            </p>
          )}
          {editor && editor.baselineUpdatedAt !== product.updatedAt && (
            <ErrorNotice message={analysisCopy.staleDraft} />
          )}
          {validation.length > 0 && (
            <div className="analysis-validation" role="alert" ref={validationRef} tabIndex={-1}>
              <strong>{analysisCopy.validationTitle}</strong>
              <ul>
                {validation.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="analysis-layout">
            <nav className="analysis-navigation" aria-label={analysisCopy.navigation}>
              {analysisSections.map((section) => (
                <a href={`#analysis-${section.id}`} key={section.id}>
                  {section.label}
                </a>
              ))}
            </nav>
            <div className="analysis-document">
              {editor ? (
                <AnalysisEditor
                  draft={editor.draft}
                  onChange={changeDraft}
                  disabled={controlsDisabled}
                />
              ) : (
                <AnalysisReader analysis={analysis!} />
              )}
            </div>
          </div>
          <p className="analysis-fact-note">{analysisCopy.factNotice}</p>
        </>
      )}
      <AnalysisHistory
        product={product}
        disabled={controlsDisabled}
        hasDraft={Boolean(retained || dirty)}
        onRestore={restoreVersion}
      />
      <div inert={controlsDisabled || Boolean(editor) ? true : undefined}>
        <HistoryManager
          kind="product"
          id={product.id}
          updatedAt={product.updatedAt}
          onChanged={async () => {
            const fresh = await productRepository.get(product.id);
            if (fresh) onUpdate(fresh);
          }}
        />
      </div>
      <AnalysisUsagePanel
        report={usageReport}
        loading={usageLoading}
        error={usageError}
        onRefresh={() => void loadUsage()}
      />
      {dialog && (
        <dialog
          ref={dialogRef}
          className="analysis-dialog"
          aria-labelledby="analysis-dialog-title"
          onCancel={(event) => {
            event.preventDefault();
            closeDialog();
          }}
        >
          <h2 id="analysis-dialog-title">
            {dialog === 'authorize'
              ? '确认调用真实 AI 服务？'
              : dialog === 'regenerate'
                ? analysisCopy.regenerateTitle
                : dialog === 'close'
                  ? analysisCopy.closeTitle
                  : analysisCopy.discard}
          </h2>
          <p>
            {dialog === 'authorize'
              ? isLegacyMode
                ? '本次操作将把商品文字资料和自定义要求发送至你在 Windows 启动器配置的服务商，可能消耗 API 额度。商品图片和视频不会上传，不会自动重试。'
                : '本次操作会将商品文字资料和自定义要求发送至工作台配置的 AI 服务，并消耗账号请求额度。商品图片和视频不会发送给模型，不会自动重试。'
              : dialog === 'regenerate'
                ? analysisCopy.regenerateDescription
                : dialog === 'close'
                  ? analysisCopy.closeDescription
                  : analysisCopy.discardConfirm}
          </p>
          {(dialog === 'regenerate' || dialog === 'authorize') && pendingGeneration && (
            <div className="analysis-generation-confirmation">
              {!isLegacyMode && (
                <p>
                  本次渠道：{pendingGeneration.ai.channelLabel} · {pendingGeneration.ai.model}
                </p>
              )}
              <p>{analysisOptionsSummary(pendingGeneration.options)}</p>
              <p>
                本次生成：
                {pendingGeneration.fields?.map((field) => analysisFieldLabels[field]).join('、') ??
                  '全部内容'}
              </p>
              {unconfirmedRequest && (
                <p>
                  上次请求结果仍未确认。继续将创建一个新请求，真实 AI
                  可能再次计费。建议取消，先“检查上次请求结果”并核对账单。
                </p>
              )}
              {dialog === 'authorize' && (
                <p>
                  {pendingGeneration.pricing
                    ? `你填写的单价：输入 $${pendingGeneration.pricing.inputUsdPerMillion} / 输出 $${pendingGeneration.pricing.outputUsdPerMillion}（每百万 Token）。实际 Token 数尚未知，最终费用以服务商账单为准。`
                    : '未配置完整模型单价，费用未知。继续并不代表免费。'}
                </p>
              )}
              {(retained || dirty) && (
                <p>
                  未保存草稿会保留，新结果生成后请手工合并需要的编辑。也可取消并先导出或保存草稿。
                </p>
              )}
            </div>
          )}
          {storageFailed && dialog === 'close' && (
            <ErrorNotice message={analysisCopy.sessionFailed} />
          )}
          <div className="analysis-dialog-actions">
            {dialog === 'close' ? (
              <>
                <Button variant="ghost" onClick={closeDialog} disabled={controlsDisabled}>
                  {analysisCopy.continueEdit}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    clearDraft();
                    setEditor(undefined);
                    setValidation([]);
                    hideDialog();
                  }}
                  disabled={controlsDisabled}
                >
                  {analysisCopy.discard}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (editor && persistDraft(editor)) {
                      setEditor(undefined);
                      setValidation([]);
                      hideDialog();
                    }
                  }}
                  disabled={controlsDisabled}
                >
                  {analysisCopy.keepClose}
                </Button>
                <Button onClick={() => void saveEdit()} disabled={controlsDisabled}>
                  {saving ? analysisCopy.saving : analysisCopy.saveClose}
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={closeDialog} disabled={controlsDisabled}>
                  {analysisCopy.cancel}
                </Button>
                <Button
                  variant={dialog === 'discard' ? 'danger' : 'primary'}
                  onClick={() => {
                    if (dialog === 'regenerate') confirmGeneration();
                    else if (dialog === 'authorize' && pendingGeneration)
                      void analyze(pendingGeneration, true);
                    else {
                      clearDraft();
                      hideDialog();
                    }
                  }}
                  disabled={controlsDisabled}
                >
                  {dialog === 'authorize'
                    ? '授权本次调用'
                    : dialog === 'regenerate'
                      ? analysisCopy.confirmRegenerate
                      : analysisCopy.discard}
                </Button>
              </>
            )}
          </div>
        </dialog>
      )}
    </div>
  );
}

export function AnalysisPanel({
  product,
  onUpdate,
}: {
  product: Product;
  onUpdate: (product: Product) => void;
}) {
  return <AnalysisContent key={product.id} product={product} onUpdate={onUpdate} />;
}
