import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronDown,
  Image,
  Loader2,
  PackageSearch,
  RefreshCw,
  Save,
  Sparkles,
  Star,
  Video,
} from 'lucide-react';
import { errorMessage } from '@productspy/shared';
import type { Product, ProductDraft } from '@productspy/shared';
import { extensionRequest, WORKSPACE_URL } from '../background/messages';
import { hasCaptureConsent, rememberCaptureConsent } from './capture-consent';
import { popupCopy } from './copy';
import { LEGACY_MODE, extensionLoginUrl } from '../config';
import type { CloudUser } from '../storage/cloud-session';

type CaptureState = 'loading' | 'captured' | 'unsupported' | 'error';
type Action = 'consent' | 'save' | 'analysis' | 'sync' | 'pair' | 'logout';

export function App() {
  const lifecycle = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState<CaptureState>('loading');
  const [draft, setDraft] = useState<ProductDraft>();
  const [savedProduct, setSavedProduct] = useState<Product>();
  const [action, setAction] = useState<Action>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [captureError, setCaptureError] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [queueError, setQueueError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const [paired, setPaired] = useState(false);
  const [user, setUser] = useState<CloudUser>();
  const [unassignedCount, setUnassignedCount] = useState(0);
  const account = useRef<string | undefined>(undefined);
  const [pairCode, setPairCode] = useState('');
  const [workspace, setWorkspace] = useState<'checking' | 'online' | 'offline'>('checking');
  const [aiMode, setAiMode] = useState<'mock' | 'real'>();
  const [consent, setConsent] = useState<'checking' | 'required' | 'accepted'>('checking');
  const [consentError, setConsentError] = useState('');
  const busy = action !== undefined;

  const checkWorkspace = useCallback(async () => {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const response = await fetch(`${WORKSPACE_URL}/api/status`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      const data: unknown = await response.json();
      if (signal.aborted) return;
      if (
        !response.ok ||
        !data ||
        typeof data !== 'object' ||
        !('ok' in data) ||
        data.ok !== true ||
        !('data' in data) ||
        !data.data ||
        typeof data.data !== 'object' ||
        (LEGACY_MODE
          ? !('mode' in data.data) || !['mock', 'real'].includes(String(data.data.mode))
          : !('status' in data.data) ||
            data.data.status !== 'ok' ||
            !('version' in data.data) ||
            typeof data.data.version !== 'string')
      )
        throw new Error(popupCopy.workspace.invalidStatus);
      setWorkspace('online');
      setAiMode(
        LEGACY_MODE && 'mode' in data.data
          ? data.data.mode === 'mock'
            ? 'mock'
            : 'real'
          : undefined,
      );
    } catch (failure: unknown) {
      if (signal.aborted) return;
      console.warn('[ProductSpy] Workspace unavailable', failure);
      setWorkspace('offline');
      setAiMode(undefined);
    }
  }, []);

  const refreshPending = useCallback(async () => {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_PENDING_COUNT' });
      if (signal.aborted) return;
      if (result.status === 'pending-count') {
        setPendingCount(result.count);
        setUnassignedCount(result.unassignedCount ?? 0);
        setQueueError(result.error ?? '');
      }
      const bridge = await extensionRequest({ type: 'PRODUCTSPY_BRIDGE_STATE' });
      if (signal.aborted) return;
      if (bridge.status === 'bridge-state') {
        setPaired(bridge.paired);
        setUser(bridge.user);
        if (account.current !== bridge.user?.id) setSavedProduct(undefined);
        account.current = bridge.user?.id;
        setConnectionError(bridge.error ?? '');
      }
    } catch (failure: unknown) {
      if (signal.aborted) return;
      console.warn('[ProductSpy] Pending count unavailable', failure);
    }
  }, []);

  const capture = useCallback(async () => {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted) return;
    setState('loading');
    setError('');
    setCaptureError('');
    setNotice('');
    setSavedProduct(undefined);
    setSaveFailed(false);
    setImageFailed(false);
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_CAPTURE' });
      if (signal.aborted) return;
      if (result.status === 'captured') {
        setDraft(result.draft);
        setState('captured');
      } else if (result.status === 'unsupported') {
        setDraft(undefined);
        setState('unsupported');
      } else {
        setCaptureError(result.status === 'error' ? result.error : popupCopy.capture.fallbackError);
        setState('error');
      }
    } catch (failure: unknown) {
      if (signal.aborted) return;
      setCaptureError(errorMessage(failure, popupCopy.capture.connectionError));
      setState('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    void hasCaptureConsent(controller.signal)
      .then((accepted) => {
        if (!controller.signal.aborted) setConsent(accepted ? 'accepted' : 'required');
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        console.error('[ProductSpy] Consent settings unavailable', failure);
        setConsent('required');
        setConsentError(popupCopy.consent.readError);
      });
    void refreshPending();
    void checkWorkspace();
    const timer = window.setInterval(() => {
      void checkWorkspace();
      if (!LEGACY_MODE) void refreshPending();
    }, 8000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refreshPending, checkWorkspace]);

  useEffect(() => {
    if (consent === 'accepted') void capture();
  }, [consent, capture]);

  async function acceptCapture() {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted) return;
    setAction('consent');
    setConsentError('');
    try {
      await rememberCaptureConsent(signal);
      if (signal.aborted) return;
      setConsent('accepted');
    } catch (failure: unknown) {
      if (signal.aborted) return;
      console.error('[ProductSpy] Consent could not be saved', failure);
      setConsentError(popupCopy.consent.saveError);
    } finally {
      if (!signal.aborted) setAction(undefined);
    }
  }

  async function openAnalysisTab(product: Product) {
    try {
      await chrome.tabs.create({
        url: `${WORKSPACE_URL}/products/${encodeURIComponent(product.id)}?tab=analysis`,
      });
      setNotice(popupCopy.feedback.analysisOpened);
    } catch (failure: unknown) {
      setError(errorMessage(failure, popupCopy.feedback.analysisError));
    }
  }

  async function save(openAnalysis = false) {
    if (!draft) return;
    setAction(openAnalysis ? 'analysis' : 'save');
    setError('');
    setNotice('');
    setSaveFailed(false);
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_SAVE', draft });
      if (result.status === 'saved') {
        setSavedProduct(result.product);
        setNotice(popupCopy.feedback.saved);
        if (openAnalysis) await openAnalysisTab(result.product);
      } else if (result.status === 'pending') {
        setSavedProduct(undefined);
        setNotice(openAnalysis ? popupCopy.feedback.pendingAnalysis : popupCopy.feedback.pending);
        setError(result.error);
      } else {
        setSaveFailed(true);
        setError(result.status === 'error' ? result.error : popupCopy.feedback.saveError);
      }
    } catch (failure: unknown) {
      setSaveFailed(true);
      setError(errorMessage(failure, popupCopy.feedback.saveError));
    } finally {
      setAction(undefined);
      await refreshPending();
    }
  }

  async function analyze() {
    if (!savedProduct) return save(true);
    setAction('analysis');
    setError('');
    setNotice('');
    try {
      await openAnalysisTab(savedProduct);
    } finally {
      setAction(undefined);
    }
  }

  async function syncPending() {
    setAction('sync');
    setError('');
    setNotice('');
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_SYNC_PENDING' });
      if (result.status === 'synced') setNotice(popupCopy.feedback.synced(result.count));
      else if (result.status === 'error') setError(result.error);
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      setAction(undefined);
      await refreshPending();
    }
  }

  async function pairWorkspace() {
    setAction('pair');
    setError('');
    setNotice('');
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_PAIR', code: pairCode });
      if (result.status === 'paired') {
        setPaired(true);
        setPairCode('');
        setNotice(popupCopy.feedback.paired);
        await checkWorkspace();
        await refreshPending();
      } else if (result.status === 'error') setError(result.error);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setAction(undefined);
    }
  }

  async function logout() {
    setAction('logout');
    setError('');
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_LOGOUT' });
      if (result.status === 'error') throw new Error(result.error);
      setSavedProduct(undefined);
      setNotice('已退出插件；原账号的待同步记录仍保留。');
      await refreshPending();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setAction(undefined);
    }
  }

  const connectionLabel =
    workspace === 'checking'
      ? popupCopy.workspace.checking
      : paired
        ? workspace === 'online'
          ? popupCopy.workspace.connected
          : popupCopy.workspace.pairedOffline
        : workspace === 'offline'
          ? popupCopy.workspace.offline
          : popupCopy.workspace.unpaired;

  return (
    <div className="popup-shell">
      <header className="popup-header">
        <div className="flex items-center gap-2.5">
          <div className="rounded-lg bg-accent p-2 text-white">
            <PackageSearch size={20} aria-hidden="true" />
          </div>
          <div>
            <span className="text-lg font-bold tracking-tight">{popupCopy.brand}</span>
            <p className="text-[13px] text-slate-300">{popupCopy.header.subtitle}</p>
          </div>
        </div>
      </header>
      <main className="popup-content">
        {consent === 'checking' && (
          <p role="status" className="py-12 text-center text-slate-500">
            {popupCopy.consent.checking}
          </p>
        )}
        {consent === 'required' && (
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h1 className="text-base font-semibold">{popupCopy.consent.title}</h1>
            <p className="mt-3 leading-6 text-slate-600">{popupCopy.consent.capture}</p>
            <p className="mt-3 leading-6 text-slate-600">{popupCopy.consent.storage}</p>
            <p className="mt-3 leading-6 text-slate-600">{popupCopy.consent.analysis}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void acceptCapture()}
              className="primary-button mt-4 w-full"
            >
              {busy ? popupCopy.consent.saving : popupCopy.consent.accept}
            </button>
            {consentError && (
              <p role="alert" className="mt-3 leading-5 text-amber-900">
                {consentError}
              </p>
            )}
          </section>
        )}
        {consent === 'accepted' && (
          <>
            {state === 'loading' && (
              <div role="status" className="capture-placeholder text-slate-500">
                <Loader2 className="animate-spin text-accent" size={28} aria-hidden="true" />
                <p className="font-medium">{popupCopy.capture.loading}</p>
                <p>{popupCopy.capture.loadingDetail}</p>
              </div>
            )}
            {(state === 'unsupported' || state === 'error') && (
              <section className="capture-placeholder text-center">
                <PackageSearch size={36} className="text-slate-400" aria-hidden="true" />
                <h1 className="text-base font-semibold">
                  {state === 'unsupported'
                    ? popupCopy.capture.unsupported
                    : popupCopy.capture.error}
                </h1>
                {state === 'error' && (
                  <p role="alert" className="text-amber-900">
                    {captureError}
                  </p>
                )}
                <p className="leading-6 text-slate-500">
                  {state === 'unsupported'
                    ? popupCopy.capture.unsupportedDetail
                    : popupCopy.capture.errorDetail}
                </p>
                <button type="button" onClick={() => void capture()} className="secondary-button">
                  <RefreshCw size={14} aria-hidden="true" />
                  {popupCopy.capture.retry}
                </button>
              </section>
            )}
            {state === 'captured' && draft && (
              <section aria-label={popupCopy.capture.captured}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span
                    role="status"
                    className="flex items-center gap-1.5 font-semibold text-accent"
                  >
                    <Check size={16} aria-hidden="true" />
                    {popupCopy.capture.captured}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void capture()}
                    className="text-button"
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {popupCopy.capture.retry}
                  </button>
                </div>
                <div className="product-image">
                  {draft.mainImage && !imageFailed ? (
                    <img
                      src={draft.mainImage}
                      alt={draft.title}
                      onError={() => setImageFailed(true)}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <span role="img" aria-label={popupCopy.product.imageUnavailable}>
                      <Image className="text-slate-300" size={42} aria-hidden="true" />
                    </span>
                  )}
                </div>
                <h1
                  className="mt-3 line-clamp-2 text-sm font-semibold leading-5"
                  title={draft.title}
                >
                  {draft.title}
                </h1>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-xl font-bold">
                    {draft.price
                      ? `${draft.price}${draft.currency && !draft.price.includes(draft.currency) ? ` ${draft.currency}` : ''}`
                      : popupCopy.product.priceUnavailable}
                  </span>
                  {draft.brand && (
                    <span className="max-w-[145px] truncate text-slate-500" title={draft.brand}>
                      {draft.brand}
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-100 px-3 py-2">
                  <span className="font-medium text-slate-500">{popupCopy.product.asin}</span>
                  <span className="font-mono font-medium">{draft.sourceId}</span>
                </div>
                <div className="mt-3 grid grid-cols-4 divide-x divide-slate-200 text-center">
                  <Stat
                    icon={<Image size={13} />}
                    label={popupCopy.product.images}
                    value={draft.images.length}
                  />
                  <Stat
                    icon={<Video size={13} />}
                    label={popupCopy.product.videos}
                    value={draft.videos.length}
                  />
                  <Stat
                    icon={<Star size={13} />}
                    label={popupCopy.product.rating}
                    value={draft.rating?.toFixed(1) ?? '—'}
                  />
                  <Stat
                    label={popupCopy.product.reviews}
                    value={draft.reviewCount?.toLocaleString() ?? '—'}
                  />
                </div>
              </section>
            )}
            <details className="connection-panel mt-4">
              <summary>
                <span
                  className={`connection-dot ${paired && workspace === 'online' ? 'connected' : ''}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">{connectionLabel}</span>
                <span className="text-slate-500">{popupCopy.workspace.setup}</span>
                <ChevronDown size={14} className="connection-chevron" aria-hidden="true" />
              </summary>
              <div className="connection-body">
                {connectionError && (
                  <p role="alert" className="text-amber-900">
                    {connectionError}
                  </p>
                )}
                {!LEGACY_MODE && user && <p className="break-all">当前账号：{user.email}</p>}
                {!LEGACY_MODE && (
                  <>
                    <p className="mt-2 break-all select-text">插件 ID：{chrome.runtime.id}</p>
                    <a
                      className="text-button mt-2"
                      href={extensionLoginUrl()}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开网页登录与授权
                    </a>
                  </>
                )}
                {workspace === 'offline' && <p>{popupCopy.workspace.offlineHint}</p>}
                {paired && workspace === 'online' && <p>{popupCopy.workspace.connectedHint}</p>}
                {!paired && (
                  <>
                    <p className={workspace === 'offline' ? 'mt-2' : ''}>
                      {popupCopy.workspace.pairHint}
                    </p>
                    <label
                      htmlFor="workspace-pair-code"
                      className="mt-3 block font-medium text-slate-700"
                    >
                      {popupCopy.workspace.pairLabel}
                    </label>
                    <input
                      id="workspace-pair-code"
                      value={pairCode}
                      onChange={(event) => setPairCode(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={40}
                      placeholder={popupCopy.workspace.pairPlaceholder}
                      className="my-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      disabled={busy || !pairCode.trim()}
                      onClick={() => void pairWorkspace()}
                      className="primary-button w-full"
                    >
                      {action === 'pair' ? popupCopy.workspace.pairing : popupCopy.workspace.pair}
                    </button>
                  </>
                )}
                {!LEGACY_MODE && paired && (
                  <button
                    type="button"
                    disabled={busy}
                    className="text-button mt-3"
                    onClick={() => void logout()}
                  >
                    {action === 'logout' ? '正在退出…' : '退出此账号'}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void checkWorkspace();
                    void refreshPending();
                  }}
                  className="text-button mt-3"
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  {popupCopy.workspace.recheck}
                </button>
              </div>
            </details>
            {queueError && (
              <p role="alert" className="mt-3 text-amber-900">
                {queueError}
              </p>
            )}
            {!LEGACY_MODE && unassignedCount > 0 && (
              <p className="mt-3 text-amber-900">
                {unassignedCount}{' '}
                件旧版本或未登录记录没有账号归属，未自动上传。请登录后重新采集并保存所需商品。
              </p>
            )}
            {pendingCount > 0 && (
              <div className="queue-panel mt-3">
                <span>{popupCopy.feedback.pendingCount(pendingCount)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void syncPending()}
                  className="text-button text-amber-900"
                >
                  <RefreshCw
                    size={13}
                    className={action === 'sync' ? 'animate-spin' : ''}
                    aria-hidden="true"
                  />
                  {action === 'sync' ? popupCopy.actions.syncing : popupCopy.actions.sync}
                </button>
              </div>
            )}
          </>
        )}
      </main>
      <footer className="popup-footer">
        {consent === 'accepted' && state === 'captured' && draft && (
          <>
            <div className="grid grid-cols-[1.1fr_1fr] gap-2" aria-busy={busy}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void save()}
                className="primary-button"
              >
                {action === 'save' ? (
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                ) : savedProduct ? (
                  <Check size={15} aria-hidden="true" />
                ) : (
                  <Save size={15} aria-hidden="true" />
                )}
                {action === 'save'
                  ? popupCopy.actions.saving
                  : saveFailed
                    ? popupCopy.actions.retrySave
                    : savedProduct
                      ? popupCopy.actions.update
                      : popupCopy.actions.save}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void analyze()}
                className="secondary-button"
              >
                {action === 'analysis' ? (
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles size={15} className="text-accent" aria-hidden="true" />
                )}
                {action === 'analysis'
                  ? savedProduct
                    ? popupCopy.actions.openingAnalysis
                    : popupCopy.actions.savingForAnalysis
                  : savedProduct
                    ? popupCopy.actions.openAnalysis
                    : popupCopy.actions.analyze}
              </button>
            </div>
            <p className="mt-2 leading-5 text-slate-500">
              {aiMode === 'mock'
                ? popupCopy.analysis.mock
                : aiMode === 'real'
                  ? popupCopy.analysis.real
                  : popupCopy.analysis.unknown}
            </p>
          </>
        )}
        {consent === 'accepted' && (notice || error) && (
          <div className="action-feedback">
            {notice && (
              <p role="status" className="text-teal-800">
                {notice}
              </p>
            )}
            {error && (
              <p role="alert" className="flex items-start gap-1.5 text-amber-900">
                <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}
          </div>
        )}
        <div className="footer-links">
          <a
            href={WORKSPACE_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 font-semibold text-accent"
          >
            {popupCopy.workspace.open}
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <a
            href={popupCopy.privacy.url}
            target="_blank"
            rel="noreferrer"
            title={popupCopy.privacy.summary}
            className="text-slate-500 hover:text-accent"
          >
            {popupCopy.privacy.label}
          </a>
        </div>
      </footer>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-center gap-1 text-[13px] text-slate-500">
        <span aria-hidden="true">{icon}</span>
        {label}
      </div>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}
