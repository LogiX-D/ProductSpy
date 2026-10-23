'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ScanLine } from 'lucide-react';
import { registerAccount, signIn } from '../lib/saas-api';
import { Button, ErrorNotice } from './ui';

export function AuthForm({ register = false }: { register?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    setBusy(true);
    setError('');
    try {
      if (register)
        await registerAccount({ email, password, name: String(form.get('name') ?? '').trim() });
      else await signIn({ email, password });
      const next = new URLSearchParams(window.location.search).get('next');
      let destination = '/';
      if (next?.startsWith('/')) {
        const target = new URL(next, window.location.origin);
        if (
          target.origin === window.location.origin &&
          target.pathname !== '/login' &&
          target.pathname !== '/register'
        )
          destination = `${target.pathname}${target.search}${target.hash}`;
      }
      router.replace(destination);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法完成，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="saas-auth-page">
      <section className="saas-auth-card" aria-labelledby="auth-title">
        <Link href="/" className="saas-auth-brand">
          <ScanLine size={25} /> ProductSpy
        </Link>
        <p className="eyebrow">AMAZON PRODUCT WORKSPACE</p>
        <h1 id="auth-title">{register ? '创建你的账号' : '登录工作台'}</h1>
        <p className="muted">采集商品、分析卖点、创作内容，在不同设备继续工作。</p>
        <form onSubmit={(event) => void submit(event)} className="saas-form">
          {register && (
            <label>
              姓名
              <input name="name" autoComplete="name" required maxLength={80} disabled={busy} />
            </label>
          )}
          <label>
            邮箱
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              disabled={busy}
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              required
              minLength={register ? 12 : 1}
              maxLength={256}
              disabled={busy}
            />
          </label>
          {register && <p className="small muted">使用至少 12 个字符的独立密码。</p>}
          {error && <ErrorNotice message={error} />}
          <Button type="submit" disabled={busy}>
            {busy ? '正在提交…' : register ? '注册并进入工作台' : '登录'}
          </Button>
        </form>
        <p className="small muted">
          {register ? '已有账号？' : '还没有账号？'}{' '}
          <Link className="ws-text-link" href={register ? '/login' : '/register'}>
            {register ? '登录' : '创建账号'}
          </Link>
        </p>
        <p className="small muted">
          注册与使用前请阅读{' '}
          <Link className="ws-text-link" href="/privacy">
            隐私说明
          </Link>
          。当前预览版暂不提供密码找回。
        </p>
      </section>
    </main>
  );
}
