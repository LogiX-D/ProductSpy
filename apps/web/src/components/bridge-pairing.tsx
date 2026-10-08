'use client';
import { useEffect, useState } from 'react';
import { errorMessage } from '@productspy/shared';
import { webRequest } from '../lib/session';
import { Button, CopyButton, ErrorNotice } from './ui';

export function BridgePairing() {
  const [code, setCode] = useState<{ code: string; expiresAt: string }>();
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void webRequest<{ paired: boolean }>('/api/bridge/status')
      .then((result) => {
        if (active) setPaired(result.paired);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!code) return;
    const timer = window.setTimeout(
      () => setCode(undefined),
      Math.max(0, Date.parse(code.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [code]);
  async function generate() {
    setBusy(true);
    setError('');
    try {
      setCode(await webRequest('/api/bridge/code', { method: 'POST', body: '{}' }));
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
          生成配对码
        </Button>
        <Button onClick={() => void revoke()} disabled={busy} variant="secondary">
          撤销扩展连接
        </Button>
      </div>
      {paired && <p className="mt-2 text-xs text-teal-700">已有扩展配对；可随时撤销。</p>}
      {code && (
        <div className="mt-3 flex items-center gap-2">
          <label className="sr-only" htmlFor="bridge-code">
            扩展配对码
          </label>
          <input
            id="bridge-code"
            readOnly
            value={code.code}
            className="min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs"
          />
          <CopyButton value={code.code} />
        </div>
      )}
      {error && <ErrorNotice message={error} />}
    </div>
  );
}
