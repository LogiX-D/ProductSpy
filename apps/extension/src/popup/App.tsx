import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronRight,
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

type CaptureState = 'loading' | 'captured' | 'unsupported' | 'error';

export function App() {
  const [state, setState] = useState<CaptureState>('loading');
  const [draft, setDraft] = useState<ProductDraft>();
  const [savedProduct, setSavedProduct] = useState<Product>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [paired, setPaired] = useState(false);
  const [pairCode, setPairCode] = useState('');
  const [workspace, setWorkspace] = useState<'checking' | 'online' | 'offline'>('checking');
  const [aiMode, setAiMode] = useState<'mock' | 'real'>();
  const [consent, setConsent] = useState<'checking' | 'required' | 'accepted'>('checking');
  const [consentError, setConsentError] = useState('');

  const checkWorkspace = useCallback(async () => {
    try {
      const response = await fetch(`${WORKSPACE_URL}/api/status`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      const data: unknown = await response.json();
      if (
        !response.ok ||
        !data ||
        typeof data !== 'object' ||
        !('ok' in data) ||
        data.ok !== true ||
        !('data' in data) ||
        !data.data ||
        typeof data.data !== 'object' ||
        !('mode' in data.data) ||
        !['mock', 'real'].includes(String(data.data.mode))
      )
        throw new Error('工作台状态无效');
      setWorkspace('online');
      setAiMode(data.data.mode === 'mock' ? 'mock' : 'real');
    } catch (failure: unknown) {
      console.warn('[ProductSpy] Workspace unavailable', failure);
      setWorkspace('offline');
      setAiMode(undefined);
    }
  }, []);

  const refreshPending = useCallback(async () => {
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_PENDING_COUNT' });
      if (result.status === 'pending-count') setPendingCount(result.count);
      const bridge = await extensionRequest({ type: 'PRODUCTSPY_BRIDGE_STATE' });
      if (bridge.status === 'bridge-state') setPaired(bridge.paired);
    } catch (failure: unknown) {
      console.warn('[ProductSpy] Pending count unavailable', failure);
    }
  }, []);

  const capture = useCallback(async () => {
    setState('loading');
    setError('');
    setNotice('');
    setSavedProduct(undefined);
    setImageFailed(false);
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_CAPTURE' });
      if (result.status === 'captured') {
        setDraft(result.draft);
        setState('captured');
      } else if (result.status === 'unsupported') {
        setDraft(undefined);
        setState('unsupported');
      } else {
        setError(result.status === 'error' ? result.error : '读取商品失败，请重试。');
        setState('error');
      }
    } catch (failure: unknown) {
      setError(errorMessage(failure, '插件连接失败，请重新打开插件。'));
      setState('error');
    }
  }, []);

  useEffect(() => {
    let active = true;
    void hasCaptureConsent()
      .then((accepted) => {
        if (active) setConsent(accepted ? 'accepted' : 'required');
      })
      .catch((failure: unknown) => {
        console.error('[ProductSpy] Consent settings unavailable', failure);
        if (active) {
          setConsent('required');
          setConsentError('无法读取本机同意设置。请重新打开扩展，或再次同意后继续。');
        }
      });
    void refreshPending();
    void checkWorkspace();
    const timer = window.setInterval(() => void checkWorkspace(), 8000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshPending, checkWorkspace]);

  useEffect(() => {
    if (consent === 'accepted') void capture();
  }, [consent, capture]);

  async function acceptCapture() {
    setBusy(true);
    setConsentError('');
    try {
      await rememberCaptureConsent();
      setConsent('accepted');
    } catch (failure: unknown) {
      console.error('[ProductSpy] Consent could not be saved', failure);
      setConsentError('无法保存本机同意设置，尚未读取商品页面。请重新打开扩展后重试。');
    } finally {
      setBusy(false);
    }
  }

  async function save(openAnalysis = false) {
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_SAVE', draft });
      if (result.status === 'saved') {
        setSavedProduct(result.product);
        setNotice('已保存到素材库，同一 ASIN 会自动更新。');
        if (openAnalysis)
          await chrome.tabs.create({
            url: `${WORKSPACE_URL}/products/${encodeURIComponent(result.product.id)}?tab=analysis`,
          });
      } else if (result.status === 'pending') {
        setSavedProduct(undefined);
        setNotice('已暂存在插件中，尚未同步到工作台。');
        setError(result.error);
      } else {
        setError(result.status === 'error' ? result.error : '保存失败，请重试。');
      }
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
      await refreshPending();
    }
  }

  async function syncPending() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_SYNC_PENDING' });
      if (result.status === 'synced') setNotice(`已同步 ${result.count} 件商品到素材库。`);
      else if (result.status === 'error') setError(result.error);
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
      await refreshPending();
    }
  }

  async function pairWorkspace() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await extensionRequest({ type: 'PRODUCTSPY_PAIR', code: pairCode });
      if (result.status === 'paired') {
        setPaired(true);
        setPairCode('');
        await checkWorkspace();
      } else if (result.status === 'error') setError(result.error);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="popup-shell flex h-[600px] flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="rounded-lg bg-accent p-2 text-white">
            <PackageSearch size={20} />
          </div>
          <span className="text-lg font-bold tracking-tight">ProductSpy</span>
        </div>
        <span className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold tracking-widest text-slate-500">
          本机素材库
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        {consent === 'checking' && (
          <p role="status" className="py-12 text-center text-sm text-slate-500">
            正在读取本机设置…
          </p>
        )}
        {consent === 'required' && (
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h1 className="text-base font-semibold">首次采集说明</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              点击同意后，ProductSpy 仅在你打开扩展时读取当前 Amazon
              商品的标题、价格、ASIN、商品链接、品牌、图片、可靠匹配的视频、卖点、描述、评分和评分数量。
            </p>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              点击保存，商品资料存入你自己的本机工作台；断线时先暂存在扩展。不会读取浏览历史、Amazon
              登录 Cookie 或支付信息。
            </p>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Mock 分析完全在本机运行。只有你配置真实 AI
              并点击分析时，选定商品的文字资料才会发送至你配置的 AI 服务商。
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void acceptCapture()}
              className="mt-5 w-full rounded-lg bg-accent px-3 py-3 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
            >
              {busy ? '正在保存设置…' : '同意并开始采集'}
            </button>
            {consentError && (
              <p role="alert" className="mt-3 text-xs leading-5 text-amber-900">
                {consentError}
              </p>
            )}
          </section>
        )}
        {consent === 'accepted' && (
          <>
            {paired ? (
              <p
                className={`mb-3 text-xs ${workspace === 'offline' ? 'text-amber-800' : 'text-teal-700'}`}
              >
                {workspace === 'online'
                  ? '工作台已连接'
                  : workspace === 'offline'
                    ? '已配对，工作台暂不可用'
                    : '正在检查工作台连接…'}
              </p>
            ) : (
              <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
                <p className="mb-2 text-xs leading-5 text-slate-500">
                  首次使用：在工作台「扩展安装说明」生成配对码，再粘贴到下方。配对码有效 2
                  分钟，过期或已使用请重新生成。
                </p>
                <label htmlFor="workspace-pair-code" className="block text-xs font-medium">
                  工作台配对码
                </label>
                <input
                  id="workspace-pair-code"
                  value={pairCode}
                  onChange={(event) => setPairCode(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={40}
                  className="my-2 w-full rounded border border-slate-200 p-2 font-mono text-xs"
                />
                <button
                  disabled={busy || !pairCode.trim()}
                  onClick={() => void pairWorkspace()}
                  className="w-full rounded bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                >
                  连接工作台
                </button>
              </div>
            )}
            {workspace === 'offline' && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                <p>
                  工作台未启动或暂时不可用。双击便携包中的
                  ProductSpy.cmd，待浏览器工作台打开后重试。商品可以先暂存于扩展。
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void checkWorkspace();
                    void refreshPending();
                  }}
                  className="mt-2 font-semibold underline"
                >
                  重新检查连接
                </button>
              </div>
            )}
            {state === 'loading' && (
              <div
                role="status"
                className="flex min-h-[210px] flex-col items-center justify-center gap-3 text-slate-500"
              >
                <Loader2 className="animate-spin text-accent" size={28} />
                <p className="text-sm">正在读取 Amazon 商品…</p>
                <p className="text-xs text-slate-400">识别基本资料与公开媒体</p>
              </div>
            )}
            {(state === 'unsupported' || state === 'error') && (
              <div className="flex min-h-[210px] flex-col items-center justify-center text-center">
                <div className="mb-4 rounded-2xl bg-slate-100 p-5 text-slate-400">
                  <PackageSearch size={36} />
                </div>
                <h1 className="text-base font-semibold">
                  {state === 'unsupported'
                    ? '当前页面不是支持的 Amazon 商品页面'
                    : '暂时无法识别商品'}
                </h1>
                <p className="mt-3 max-w-[300px] text-sm leading-6 text-slate-500">
                  {state === 'unsupported'
                    ? '打开 Amazon 商品详情页，再点击 ProductSpy 采集商品资料。'
                    : `${error} 等待页面加载完成后，点击「重新识别」；也可刷新 Amazon 页面后再次打开扩展。`}
                </p>
                <button
                  onClick={() => void capture()}
                  className="mt-5 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium"
                >
                  <RefreshCw size={14} />
                  重新识别
                </button>
              </div>
            )}
            {state === 'captured' && draft && (
              <>
                <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-accent">
                  <Check size={14} />
                  Amazon Product Captured
                </div>
                <div className="flex h-[132px] items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white p-3">
                  {draft.mainImage && !imageFailed ? (
                    <img
                      src={draft.mainImage}
                      alt={draft.title}
                      onError={() => setImageFailed(true)}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <Image className="text-slate-300" size={42} />
                  )}
                </div>
                <h1 className="mt-3 line-clamp-2 text-[14px] font-semibold leading-5">
                  {draft.title}
                </h1>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xl font-bold">
                    {draft.price
                      ? `${draft.price}${draft.currency && !draft.price.includes(draft.currency) ? ` ${draft.currency}` : ''}`
                      : '价格暂不可用'}
                  </span>
                  <span className="max-w-[145px] truncate text-xs text-slate-500">
                    {draft.brand ?? 'Amazon'}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-100 px-3 py-2">
                  <span className="text-[11px] font-medium tracking-wide text-slate-500">ASIN</span>
                  <span className="font-mono text-xs font-medium">{draft.sourceId}</span>
                </div>
                <div className="mt-3 grid grid-cols-4 divide-x divide-slate-200 text-center">
                  <Stat icon={<Image size={13} />} label="图片" value={draft.images.length} />
                  <Stat icon={<Video size={13} />} label="视频" value={draft.videos.length} />
                  <Stat
                    icon={<Star size={13} />}
                    label="评分"
                    value={draft.rating?.toFixed(1) ?? '—'}
                  />
                  <Stat label="评论" value={draft.reviewCount?.toLocaleString() ?? '—'} />
                </div>
              </>
            )}
            {notice && (
              <p
                role="status"
                className="mt-4 rounded-lg border border-teal-100 bg-teal-50 px-3 py-2.5 text-xs leading-5 text-teal-800"
              >
                {notice}
              </p>
            )}
            {error && state !== 'error' && (
              <div
                role="alert"
                className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900"
              >
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <p>{error}</p>
              </div>
            )}
            {pendingCount > 0 && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
                <p className="text-xs text-amber-900">
                  {pendingCount} 件商品暂存在插件中，等待同步。
                </p>
                <button
                  disabled={busy}
                  onClick={() => void syncPending()}
                  className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-amber-900 disabled:opacity-60"
                >
                  <RefreshCw size={12} />
                  重试同步
                </button>
              </div>
            )}
          </>
        )}
      </main>
      <footer className="shrink-0 border-t border-slate-200 bg-white px-5 py-3">
        {state === 'captured' && draft && (
          <div className="mb-2">
            <div className="grid grid-cols-[1.45fr_1fr] gap-2">
              <button
                disabled={busy}
                onClick={() => void save()}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-accent py-2.5 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : savedProduct ? (
                  <Check size={15} />
                ) : (
                  <Save size={15} />
                )}
                {busy ? '正在保存…' : savedProduct ? '再次保存并更新' : '保存到素材库'}
              </button>
              <button
                disabled={busy}
                onClick={() => void save(true)}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white py-2.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-60"
              >
                <Sparkles size={15} className="text-accent" />
                AI 分析
                <ChevronRight size={13} className="text-slate-400" />
              </button>
            </div>
            <p className="mt-1.5 text-center text-[10px] text-slate-500">
              {aiMode === 'mock'
                ? '未配置 AI Key：在工作台体验 Mock 演示分析'
                : aiMode === 'real'
                  ? 'AI 分析将在工作台打开，使用你配置的服务'
                  : 'AI 分析在工作台运行，默认支持 Mock 演示'}
            </p>
          </div>
        )}
        <p className="mb-2 text-[10px] leading-4 text-slate-500">
          点击扩展仅读取当前商品；保存至本机工作台。真实 AI 分析会将商品文字发送至你配置的服务。
          <a
            href="https://github.com/LogiX-D/ProductSpy/blob/main/PRIVACY.md"
            target="_blank"
            rel="noreferrer"
            className="ml-1 text-accent underline"
          >
            隐私说明
          </a>
        </p>
        <a
          href={WORKSPACE_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between text-xs font-medium text-slate-600"
        >
          打开 ProductSpy 工作台
          <ArrowUpRight size={15} />
        </a>
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
      <div className="mb-1 flex items-center justify-center gap-1 text-[10px] text-slate-500">
        {icon}
        {label}
      </div>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}
