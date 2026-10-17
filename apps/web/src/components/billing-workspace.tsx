'use client';
import { useState } from 'react';
import { openBilling, refreshBilling } from '../lib/saas-api';
import { useAccount } from './saas-access';
import { AccountUsage } from './account-usage';
import { Button, ErrorNotice, PageHeading } from './ui';

export function BillingWorkspace() {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  if (!account) return null;
  async function open(kind: 'checkout' | 'portal') {
    setBusy(true);
    setError('');
    try {
      window.location.assign(await openBilling(kind));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法打开账单。');
      setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await refreshBilling();
      setNotice('已核对支付平台的最新订阅状态。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法刷新订阅。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ws-page">
      <PageHeading title="订阅与账单" description="查看套餐、资源上限及本月用量。" />
      <AccountUsage />
      {error && <ErrorNotice message={error} />}
      {notice && <p role="status">{notice}</p>}
      <div className="saas-settings-grid">
        <section className="panel saas-settings-panel">
          <p className="eyebrow">FREE</p>
          <h2>开始整理商品</h2>
          <p>50 件商品 · 每月 10 次 AI 请求</p>
          {account.subscription.plan === 'free' && <p className="badge badge-success">当前套餐</p>}
        </section>
        <section className="panel saas-settings-panel">
          <p className="eyebrow">PRO</p>
          <h2>更多内容创作额度</h2>
          <p>5,000 件商品 · 每月 500 次 AI 请求</p>
          {account.subscription.plan === 'pro' ? (
            <p className="badge badge-success">当前套餐</p>
          ) : (
            <Button
              disabled={busy || !account.billingEnabled}
              onClick={() => void open('checkout')}
            >
              {busy ? '正在打开…' : '查看 Pro 订阅'}
            </Button>
          )}
        </section>
      </div>
      <section className="panel saas-settings-panel">
        <h2>账单管理</h2>
        <p>订阅状态：{account.subscription.status}</p>
        {account.billingEnabled ? (
          <>
            <p className="muted">价格、计费周期和支付模式以付款页为准。付款后可刷新订阅状态。</p>
            <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>
              刷新订阅状态
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void open('portal')}>
              管理订阅与账单
            </Button>
          </>
        ) : (
          <p className="muted">
            当前环境尚未启用支付，无法购买或管理订阅。套餐与用量仍由服务端执行。
          </p>
        )}
        <p className="small muted">
          AI 额度按 UTC 自然月统计。演示、失败和中断请求也计入；相同请求的安全恢复不会重复扣量。
        </p>
      </section>
    </div>
  );
}
