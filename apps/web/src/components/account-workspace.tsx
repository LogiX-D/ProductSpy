'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { changePassword, signOut, updateAccountName } from '../lib/saas-api';
import { useAccount } from './saas-access';
import { Button, ErrorNotice, PageHeading } from './ui';
import { AccountUsage } from './account-usage';

export function AccountWorkspace() {
  const account = useAccount();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  if (!account) return null;
  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await updateAccountName(name);
      setMessage('账号资料已保存。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  }
  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== form.get('confirmation')) {
      setError('两次新密码不一致。');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await changePassword(String(form.get('currentPassword') ?? ''), password);
      router.replace('/login?password=changed');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '密码修改失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ws-page">
      <PageHeading title="账号设置" description="管理账号资料和登录密码。" />
      <AccountUsage />
      <div>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError('');
            void signOut().catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : '退出失败，请重试。');
              setBusy(false);
            });
          }}
        >
          退出登录
        </Button>
      </div>
      {error && <ErrorNotice message={error} />}
      {message && <p role="status">{message}</p>}
      <div className="saas-settings-grid">
        <section className="panel saas-settings-panel">
          <h2>个人资料</h2>
          <form className="saas-form" onSubmit={(event) => void saveName(event)}>
            <label>
              邮箱
              <input type="email" value={account.user.email} disabled />
            </label>
            <label>
              姓名
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={account.user.name}
                disabled={busy}
              />
            </label>
            <p className="small muted">
              注册于 {new Date(account.user.createdAt).toLocaleDateString('zh-CN')}
            </p>
            <Button type="submit" disabled={busy}>
              保存资料
            </Button>
          </form>
        </section>
        <section className="panel saas-settings-panel">
          <h2>修改密码</h2>
          <form className="saas-form" onSubmit={(event) => void savePassword(event)}>
            <label>
              当前密码
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                disabled={busy}
              />
            </label>
            <label>
              新密码
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={256}
                disabled={busy}
              />
            </label>
            <label>
              确认新密码
              <input
                name="confirmation"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={256}
                disabled={busy}
              />
            </label>
            <p className="small muted">至少 12 个字符。修改后所有设备和扩展需要重新登录或授权。</p>
            <Button type="submit" disabled={busy}>
              更新密码并重新登录
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
