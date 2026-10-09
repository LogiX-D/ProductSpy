'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Pencil, Save, Sparkles, X } from 'lucide-react';
import {
  ApiRequestError,
  analysisSchema,
  apiRequest,
  errorMessage,
  type Product,
  type ProductAnalysis,
} from '@productspy/shared';
import { productRepository } from '../lib/storage/product-api';
import { webRequest } from '../lib/session';
import { analysisCopy } from './analysis-copy';
import { AnalysisEditor } from './analysis-editor';
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
};

function AnalysisContent({
  product,
  onUpdate,
}: {
  product: Product;
  onUpdate: (product: Product) => void;
}) {
  const [mode, setMode] = useState<'mock' | 'real'>();
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
  const [dialog, setDialog] = useState<'close' | 'regenerate' | 'discard'>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const validationRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const analysis =
    generated?.baselineUpdatedAt === product.updatedAt ? generated.analysis : product.aiAnalysis;
  const isMock = editor?.isMock ?? (analysis ? isMockAnalysis(analysis.summary) : mode === 'mock');
  const dirty = Boolean(
    editor &&
    (editor.baselineUpdatedAt !== product.updatedAt ||
      JSON.stringify(editor.draft) !== JSON.stringify(editor.initialDraft)),
  );
  const controlsDisabled = busy || saving;

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
    let active = true;
    void apiRequest<{ mode: 'mock' | 'real' }>('/api/status')
      .then((status) => {
        if (active) setMode(status.mode);
      })
      .catch(() => {
        /* Saved analyses remain usable if status is unavailable. */
      });
    const volatile = volatileDrafts.get(product.id);
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
      active = false;
      mounted.current = false;
    };
  }, [product.id, product.updatedAt]);

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
      const volatile = volatileDrafts.get(product.id);
      if (
        expectedSerialized !== undefined &&
        (volatile
          ? JSON.stringify(volatile)
          : sessionStorage.getItem(sessionDraftKey(product.id))) !== expectedSerialized
      )
        return;
      volatileDrafts.delete(product.id);
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
      volatileDrafts.set(product.id, session);
      setRetained(session);
      setStorageFailed(true);
      return false;
    };
    try {
      const serialized = JSON.stringify(session);
      if (serialized.length > sessionDraftMaxCharacters) return keepVolatile();
      sessionStorage.setItem(sessionDraftKey(product.id), serialized);
      volatileDrafts.delete(product.id);
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
        analysisSchema.parse(draftToAnalysis(editor.draft, editor.isMock)),
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

  async function analyze() {
    if (controlsDisabled) return;
    hideDialog();
    setBusy(true);
    setError('');
    setMessage('');
    const draftAtStart = retained ? JSON.stringify(retained) : null;
    try {
      const data = await webRequest<unknown>('/api/analyze-product', {
        method: 'POST',
        body: JSON.stringify(product),
        signal: AbortSignal.timeout(90000),
      });
      const result = analysisSchema.parse(data);
      clearDraft(draftAtStart);
      if (mounted.current) {
        setGenerated({ analysis: result, baselineUpdatedAt: product.updatedAt });
        setEditor(undefined);
        setValidation([]);
      }
      try {
        const updated = await productRepository.get(product.id);
        if (updated) onUpdate(updated);
      } catch {
        if (mounted.current) setError(analysisCopy.refreshFailed);
      }
    } catch (reason: unknown) {
      if (mounted.current)
        setError(
          reason instanceof ApiRequestError && reason.status === 409
            ? analysisCopy.analyzeConflict
            : `${analysisCopy.analyzeFailed} ${errorMessage(reason)}`,
        );
    } finally {
      if (mounted.current) setBusy(false);
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
          <Button
            onClick={() =>
              analysis || retained || editor ? setDialog('regenerate') : void analyze()
            }
            disabled={controlsDisabled}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
            {busy
              ? analysisCopy.generating
              : analysis
                ? analysisCopy.regenerate
                : analysisCopy.start}
          </Button>
        </div>
      </div>
      {error && (
        <div className="analysis-error-summary" ref={errorRef} tabIndex={-1}>
          <ErrorNotice message={error} />
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
                      draftToAnalysis(editor.draft, editor.isMock),
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
                <CopyButton
                  value={analysisAllText(analysis!, isMock)}
                  label={analysisCopy.copyAll}
                />
              </>
            )}
          </div>
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
            {dialog === 'regenerate'
              ? analysisCopy.regenerateTitle
              : dialog === 'close'
                ? analysisCopy.closeTitle
                : analysisCopy.discard}
          </h2>
          <p>
            {dialog === 'regenerate'
              ? analysisCopy.regenerateDescription
              : dialog === 'close'
                ? analysisCopy.closeDescription
                : analysisCopy.discardConfirm}
          </p>
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
                    if (dialog === 'regenerate') void analyze();
                    else {
                      clearDraft();
                      hideDialog();
                    }
                  }}
                  disabled={controlsDisabled}
                >
                  {dialog === 'regenerate' ? analysisCopy.confirmRegenerate : analysisCopy.discard}
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
