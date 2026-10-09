'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useProducts } from '@/lib/use-products';
import { EmptyState, ErrorNotice, LoadingState, PageHeading } from './ui';
import { ProductCard } from './product-card';
import { OpenSetupButton } from './first-use-guide';
import { workspaceCopy as copy } from './workspace-copy';
import { DEFAULT_LIBRARY_PREFERENCES, selectLibraryProducts } from './workspace-preferences';

function startOfWeek(): number {
  const date = new Date();
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function Dashboard() {
  const { products, loading, error, reload } = useProducts();
  const recent = selectLibraryProducts(products, DEFAULT_LIBRARY_PREFERENCES).slice(0, 6);
  const weekStart = startOfWeek();
  const metrics = [
    { label: copy.dashboard.total, value: products.length, href: '/products' },
    {
      label: copy.dashboard.thisWeek,
      value: products.filter((product) => Date.parse(product.createdAt) >= weekStart).length,
    },
    {
      label: copy.dashboard.pending,
      value: products.filter((product) => !product.aiAnalysis).length,
      href: '/products?analysis=pending',
    },
  ];
  return (
    <div className="ws-page ws-dashboard">
      <PageHeading title={copy.dashboard.title} description={copy.dashboard.description} />
      {error && <ErrorNotice message={error} onRetry={() => void reload()} />}
      <dl className="ws-dashboard-summary" aria-label={copy.dashboard.metrics}>
        {metrics.map(({ label, value, href }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {href ? (
                <Link href={href}>
                  {loading ? '—' : value}
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
              ) : loading ? (
                '—'
              ) : (
                value
              )}
            </dd>
          </div>
        ))}
      </dl>
      <section>
        <div className="section-header">
          <div>
            <h2>{copy.dashboard.recent}</h2>
            <p className="small muted">{copy.dashboard.recentDescription}</p>
          </div>
          <Link href="/products" className="ws-text-link">
            {copy.dashboard.viewAll}
            <ArrowRight size={15} />
          </Link>
        </div>
        {loading ? (
          <LoadingState />
        ) : recent.length === 0 ? (
          <EmptyState
            title={error ? copy.library.unavailable : copy.library.emptyTitle}
            description={
              error ? copy.library.unavailableDescription : copy.library.emptyDescription
            }
            action={!error && <OpenSetupButton />}
          />
        ) : (
          <div className="ws-products-grid ws-recent-grid">
            {recent.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
