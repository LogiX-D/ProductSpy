'use client';
import { useEffect, useState } from 'react';
import { errorMessage } from '@productspy/shared';
import { isLegacyMode, webRequest } from '../lib/session';
import { Button, CopyButton, ErrorNotice } from './ui';

export function pairingSecondsLeft(expiresAt: string, now = Date.now()): number {
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - now) / 1000)) : 0;
}

export function BridgePairing() {
  return isLegacyMode ? <LegacyBridgePairing /> : <CloudExtensionConnection />;
}

function CloudExtensionConnection() {
  const [paired, setPaired] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void webRequest<{ paired: boolean }>('/api/bridge/status', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setPaired(result.paired);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('暂时无法读取扩展连接状态。请检查网络后重试。');
      });
    return () => controller.abort();
  }, []);
  async function revoke() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await webRequest('/api/bridge/revoke', { method: 'POST', body: '{}' });
      setPaired(false);
      setNotice(
        '已撤销现有扩展连接。网页保持登录时，下次打开扩展会自动连接；如需停止连接，请在扩展退出账号或退出网页登录。',
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <h3 className="text-sm font-semibold">Chrome 扩展连接</h3>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        安装扩展后即可使用。扩展会自动连接当前浏览器已登录的 ProductSpy
        账号；未登录时，只需在网页登录账号，再回到扩展继续。
      </p>
      <p role="status" className="mt-2 text-xs text-slate-600">
        {paired === undefined
          ? error
            ? '连接状态暂不可用。'
            : '正在读取连接状态…'
          : paired
            ? '当前账号有有效的扩展连接。'
            : '当前账号暂无有效的扩展连接。'}
      </p>
      <Button onClick={() => void revoke()} disabled={busy || !paired} variant="secondary">
        {busy ? '正在撤销…' : '撤销扩展连接'}
      </Button>
      {notice && (
        <p role="status" className="mt-2 text-xs text-teal-700">
          {notice}
        </p>
      )}
      {error && <ErrorNotice message={error} />}
    </div>
  );
}

function LegacyBridgePairing() {
  const [code, setCode] = useState<{ code: string; expiresAt: string }>();
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [extensionId, setExtensionId] = useState('');
  useEffect(() => {
    const candidate = new URLSearchParams(window.location.search).get('extensionId') ?? '';
    if (/^[a-p]{32}$/.test(candidate)) setExtensionId(candidate);
  }, []);
  const codeActive = Boolean(code && secondsLeft > 0);
  useEffect(() => {
    let active = true;
    void webRequest<{ paired: boolean }>('/api/bridge/status')
      .then((result) => {
        if (active) setPaired(result.paired);
      })
      .catch((failure: unknown) => {
        console.warn('[ProductSpy] Pairing status unavailable', failure);
        if (active) setError('暂时无法读取扩展授权状态。请检查网络后重试。');
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!code) return;
    const tick = () => setSecondsLeft(pairingSecondsLeft(code.expiresAt));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [code]);
  useEffect(() => {
    if (!codeActive) return;
    let active = true;
    const timer = window.setInterval(() => {
      void webRequest<{ paired: boolean }>('/api/bridge/status')
        .then((result) => {
          if (active) setPaired(result.paired);
        })
        .catch((failure: unknown) => console.warn('[ProductSpy] Pairing refresh failed', failure));
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [codeActive]);
  async function generate() {
    if (!isLegacyMode && !/^[a-p]{32}$/.test(extensionId.trim())) {
      setError('请输入有效的 Chrome 扩展 ID（32 个 a–p 字母）。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await webRequest<{ code: string; expiresAt: string }>('/api/bridge/code', {
        method: 'POST',
        body: JSON.stringify(
          isLegacyMode ? {} : { extensionOrigin: `chrome-extension://${extensionId.trim()}` },
        ),
      });
      setSecondsLeft(pairingSecondsLeft(next.expiresAt));
      setCode(next);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    setBusy(true);
    setError('');
    try {
      await webRequest('/api/bridge/revoke', { method: 'POST', body: '{}' });
      setPaired(false);
      setCode(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <h3 className="text-sm font-semibold">
        {isLegacyMode ? '连接本机工作台' : '授权 Chrome 扩展访问当前账号'}
      </h3>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        {isLegacyMode
          ? '生成一次性配对码，复制到插件的「工作台配对码」。配对码有效 2 分钟，只能使用一次；重新配对会撤销旧连接。'
          : '核对插件显示的扩展 ID，生成仅供该扩展使用的一次性授权码，再复制回插件完成登录。授权码有效 2 分钟；请勿分享。'}
      </p>
      {!isLegacyMode && (
        <label className="saas-extension-field">
          Chrome 扩展 ID
          <input
            value={extensionId}
            onChange={(event) => {
              setExtensionId(event.target.value);
              setCode(undefined);
            }}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            placeholder="32 个 a–p 字母"
          />
        </label>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void generate()} disabled={busy}>
          {busy ? '正在处理…' : '生成配对码'}
        </Button>
        <Button onClick={() => void revoke()} disabled={busy} variant="secondary">
          撤销扩展连接
        </Button>
      </div>
      {paired && (
        <p className="mt-2 text-xs text-teal-700">
          已有扩展授权；可随时撤销当前账号的全部扩展连接。
        </p>
      )}
      {code && secondsLeft > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="bridge-code">
              扩展配对码
            </label>
            <input
              id="bridge-code"
              readOnly
              value={code.code}
              className="min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs"
            />
            <CopyButton value={code.code} label="复制" />
          </div>
          <p className="mt-2 text-xs text-slate-500">{secondsLeft} 秒后过期 · 单次使用</p>
        </div>
      )}
      {code && secondsLeft === 0 && (
        <p role="status" className="mt-3 text-xs text-amber-800">
          配对码已过期。点击「生成配对码」重新获取；已建立的连接不受影响。
        </p>
      )}
      {error && <ErrorNotice message={error} />}
    </div>
  );
}
