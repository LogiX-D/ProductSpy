'use client';

import Link from 'next/link';
import { ArrowRight, CalendarDays, Library, Sparkles } from 'lucide-react';
import { useProducts } from '@/lib/use-products';
import { EmptyState, ErrorNotice, LoadingState, PageHeading } from './ui';
import { ProductCard } from './product-card';
import { OpenSetupButton } from './first-use-guide';

function startOfWeek(): number {
  const date = new Date();
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function Dashboard() {
  const { products, loading, error, reload } = useProducts();
  const weekStart = startOfWeek();
  const metrics = [
    {
      label: '已采集商品',
      value: products.length,
      note: '你的竞品素材库',
      icon: Library,
      color: 'bg-teal-50 text-teal-700',
    },
    {
      label: '本周新增',
      value: products.filter((product) => new Date(product.createdAt).getTime() >= weekStart)
        .length,
      note: '从本周一开始',
      icon: CalendarDays,
      color: 'bg-blue-50 text-blue-600',
    },
    {
      label: '待分析商品',
      value: products.filter((product) => !product.aiAnalysis).length,
      note: '等待发现内容角度',
      icon: Sparkles,
      color: 'bg-amber-50 text-amber-600',
    },
  ];
  const recent = [...products]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 6);

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow="AMAZON 商品素材工作台"
        title="让每一份素材，都有新发现。"
        description="从 Amazon 采集竞品，用 AI 把产品信息变成内容灵感。"
      />
      {error && <ErrorNotice message={error} onRetry={() => void reload()} />}
      <section aria-label="素材库统计" className="grid gap-4 sm:grid-cols-3">
        {metrics.map(({ label, value, note, icon: Icon, color }) => (
          <article key={label} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">{label}</span>
              <span className={`rounded-lg p-2 ${color}`}>
                <Icon size={18} />
              </span>
            </div>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{loading ? '—' : value}</p>
            <p className="mt-2 text-xs text-slate-400">{note}</p>
          </article>
        ))}
      </section>
      <section>
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">最近商品</h2>
            <p className="mt-1 text-sm text-slate-500">最近采集或更新的竞品。</p>
          </div>
          <Link
            href="/products"
            className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-teal-700 hover:text-teal-900"
          >
            查看全部
            <ArrowRight size={15} />
          </Link>
        </div>
        {loading ? (
          <LoadingState />
        ) : recent.length === 0 ? (
          <EmptyState
            title="还没有采集商品"
            description="打开 Amazon 商品页面，通过 ProductSpy 插件保存第一个商品。"
            action={<OpenSetupButton />}
          />
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {recent.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
