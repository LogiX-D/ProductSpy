'use client';
import { useEffect, useState } from 'react';
import { errorMessage } from '@productspy/shared';
import { webRequest } from '../lib/session';
import { Button, CopyButton, ErrorNotice } from './ui';

export function pairingSecondsLeft(expiresAt: string, now = Date.now()): number {
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - now) / 1000)) : 0;
}

export function BridgePairing() {
  const [code, setCode] = useState<{ code: string; expiresAt: string }>();
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const codeActive = Boolean(code && secondsLeft > 0);
  useEffect(() => {
    let active = true;
    void webRequest<{ paired: boolean }>('/api/bridge/status')
      .then((result) => {
        if (active) setPaired(result.paired);
      })
      .catch((failure: unknown) => {
        console.warn('[ProductSpy] Pairing status unavailable', failure);
        if (active) setError('暂时无法读取工作台连接状态。请确认本地服务正在运行，再生成配对码。');
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
    setBusy(true);
    setError('');
    try {
      const next = await webRequest<{ code: string; expiresAt: string }>('/api/bridge/code', {
        method: 'POST',
        body: '{}',
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
      <h3 className="text-sm font-semibold">连接本机工作台</h3>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        生成一次性配对码，复制到插件的「工作台配对码」。配对码有效 2
        分钟，只能使用一次；重新配对会撤销旧连接。
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void generate()} disabled={busy}>
          {busy ? '正在处理…' : '生成配对码'}
        </Button>
        <Button onClick={() => void revoke()} disabled={busy} variant="secondary">
          撤销扩展连接
        </Button>
      </div>
      {paired && <p className="mt-2 text-xs text-teal-700">已有扩展配对；可随时撤销。</p>}
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
