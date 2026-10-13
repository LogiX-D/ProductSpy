'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  ExternalLink,
  GitCompareArrows,
  RefreshCw,
  Star,
  WandSparkles,
} from 'lucide-react';
import { ApiRequestError, errorMessage, type Product } from '@productspy/shared';
import { productRepository } from '../lib/storage/product-api';
import { comparisonSelectionHref } from '../lib/comparison-api';
import { formatDate, formatPrice } from '../lib/format';
import { Badge, Button, CopyButton, EmptyState, ErrorNotice, LoadingState } from './ui';
import { ProductGallery } from './product-gallery';
import { ProductMedia } from './product-media';
import { AnalysisPanel } from './analysis-panel';
import { workspaceCopy as copy } from './workspace-copy';

type Tab = 'overview' | 'media' | 'analysis';
const TAB_ORDER: Tab[] = ['overview', 'media', 'analysis'];
function asTab(value?: string | null): Tab {
  return value === 'media' || value === 'analysis' ? value : 'overview';
}

export function ProductDetail({ id, initialTab }: { id: string; initialTab?: string }) {
  const [product, setProduct] = useState<Product>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<Tab>(asTab(initialTab));
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement>>>({});
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void productRepository
      .get(id)
      .then((value) => {
        if (active) setProduct(value);
      })
      .catch((reason: unknown) => {
        if (reason instanceof ApiRequestError && reason.status === 404) {
          if (active) setProduct(undefined);
          return;
        }
        console.error('[ProductSpy] Product detail load failed', reason);
        if (active) setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, revision]);
  useEffect(() => {
    const restoreTab = () => setTab(asTab(new URLSearchParams(window.location.search).get('tab')));
    window.addEventListener('popstate', restoreTab);
    return () => window.removeEventListener('popstate', restoreTab);
  }, []);
  const reload = () => setRevision((value) => value + 1);
  function selectTab(nextTab: Tab) {
    setTab(nextTab);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', nextTab);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, current: Tab) {
    const index = TAB_ORDER.indexOf(current);
    let next: Tab | undefined;
    if (event.key === 'ArrowRight') next = TAB_ORDER[(index + 1) % TAB_ORDER.length];
    else if (event.key === 'ArrowLeft')
      next = TAB_ORDER[(index + TAB_ORDER.length - 1) % TAB_ORDER.length];
    else if (event.key === 'Home') next = TAB_ORDER[0];
    else if (event.key === 'End') next = TAB_ORDER[TAB_ORDER.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    tabRefs.current[next]?.focus();
  }
  if (loading) return <LoadingState />;
  if (error)
    return (
      <div className="ws-page">
        <Link className="breadcrumb" href="/products">
          {copy.common.backToLibrary}
        </Link>
        <ErrorNotice message={error} onRetry={reload} />
      </div>
    );
  if (!product)
    return (
      <EmptyState
        title={copy.detail.missing}
        description={copy.detail.missingDescription}
        action={
          <Link className="button button-secondary" href="/products">
            {copy.common.backToLibrary}
          </Link>
        }
      />
    );
  const mediaCount =
    new Set([product.mainImage, ...product.images].filter(Boolean)).size + product.videos.length;
  const tabs = [
    ['overview', copy.detail.overview],
    ['media', `${copy.detail.media} · ${mediaCount}`],
    ['analysis', copy.detail.analysis],
  ] as const;
  return (
    <div className="ws-product-detail">
      <nav className="breadcrumb" aria-label={copy.common.backToLibrary}>
        <Link href="/products">{copy.common.library}</Link>
        <ChevronRight size={12} />
        <span>{product.sourceId}</span>
      </nav>
      <div className="ws-detail-top">
        <ProductGallery product={product} />
        <div className="ws-detail-info">
          <div className="ws-inline">
            <Badge>{copy.common.amazon}</Badge>
            <Badge tone={product.aiAnalysis ? 'success' : 'warning'}>
              {product.aiAnalysis ? copy.common.analyzed : copy.common.pending}
            </Badge>
          </div>
          <h1>{product.title}</h1>
          <p className="ws-detail-price">{formatPrice(product)}</p>
          <div className="ws-detail-rating">
            <Star size={14} aria-hidden="true" />
            <span>{product.rating ?? copy.detail.noRating}</span>
            <span>·</span>
            <span>{copy.detail.reviews(product.reviewCount?.toLocaleString('zh-CN') ?? '—')}</span>
          </div>
          <dl className="ws-detail-meta">
            <div>
              <dt>ASIN</dt>
              <dd>{product.sourceId}</dd>
            </div>
            <div>
              <dt>{copy.detail.brand}</dt>
              <dd>{product.brand ?? copy.common.unknown}</dd>
            </div>
            <div>
              <dt>{copy.detail.collected}</dt>
              <dd>{formatDate(product.createdAt)}</dd>
            </div>
            <div>
              <dt>{copy.detail.updated}</dt>
              <dd>{formatDate(product.updatedAt)}</dd>
            </div>
          </dl>
          <div className="ws-detail-actions">
            <Link
              className="button button-primary"
              href={`/content?product=${encodeURIComponent(product.id)}`}
            >
              <WandSparkles size={14} />
              创作营销内容
            </Link>
            <Link className="button button-secondary" href={comparisonSelectionHref([product.id])}>
              <GitCompareArrows size={14} />
              加入竞品对比
            </Link>
            <a
              className="button button-secondary"
              href={product.url}
              target="_blank"
              rel="noreferrer"
            >
              {copy.detail.original}
              <ExternalLink size={13} />
            </a>
            <CopyButton value={product.url} label={copy.detail.copyLink} />
            <Button variant="ghost" onClick={reload} aria-label={copy.detail.refresh}>
              <RefreshCw size={14} />
              {copy.common.refresh}
            </Button>
          </div>
        </div>
      </div>
      <div className="tabs ws-detail-tabs" role="tablist" aria-label={copy.detail.content}>
        {tabs.map(([value, label]) => (
          <button
            key={value}
            ref={(node) => {
              if (node) tabRefs.current[value] = node;
              else delete tabRefs.current[value];
            }}
            className="tab"
            type="button"
            role="tab"
            id={`tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => selectTab(value)}
            onKeyDown={(event) => navigateTabs(event, value)}
          >
            {label}
          </button>
        ))}
      </div>
      {TAB_ORDER.map((value) => (
        <div
          key={value}
          role="tabpanel"
          hidden={tab !== value}
          tabIndex={tab === value ? 0 : -1}
          id={`panel-${value}`}
          aria-labelledby={`tab-${value}`}
          className="ws-detail-panel"
        >
          {tab === value && value === 'overview' && (
            <div className="ws-overview-grid">
              <section className="panel ws-content-panel">
                <h2>{copy.detail.points}</h2>
                {product.bulletPoints.length ? (
                  <ul>
                    {product.bulletPoints.map((point, index) => (
                      <li key={`${index}-${point}`}>{point}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{copy.detail.noPoints}</p>
                )}
              </section>
              <section className="panel ws-content-panel">
                <h2>{copy.detail.description}</h2>
                <p className="description">{product.description ?? copy.detail.noDescription}</p>
              </section>
            </div>
          )}
          {tab === value && value === 'media' && (
            <ProductMedia key={product.id} product={product} />
          )}
          {tab === value && value === 'analysis' && (
            <AnalysisPanel product={product} onUpdate={setProduct} />
          )}
        </div>
      ))}
    </div>
  );
}
