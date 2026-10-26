'use client';
import Link from 'next/link';
import { useAccount } from './saas-access';

export function AccountUsage() {
  const account = useAccount();
  if (!account) return null;
  return (
    <section className="saas-usage panel" aria-label="套餐与用量">
      <div>
        <strong>{account.subscription.plan === 'pro' ? 'Pro' : 'Free'} 套餐</strong>
        <p className="small muted">账号资源与用量由服务端控制</p>
      </div>
      <div>
        <span className="small muted">商品库</span>
        <p>
          <strong>{account.usage.products}</strong> / {account.limits.products}
        </p>
      </div>
      <div>
        <span className="small muted">本月 AI 请求</span>
        <p>
          <strong>{account.usage.ai}</strong> / {account.limits.ai}
        </p>
      </div>
      <Link className="ws-text-link" href="/billing">
        订阅与账单
      </Link>
    </section>
  );
}
