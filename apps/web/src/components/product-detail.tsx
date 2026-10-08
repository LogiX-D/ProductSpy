'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, ExternalLink, RefreshCw, Sparkles, Star } from 'lucide-react';
import { errorMessage, type Product } from '@productspy/shared';
import { productRepository } from '../lib/storage/product-api';
import { formatDate, formatPrice } from '../lib/format';
import { Badge, Button, EmptyState, ErrorNotice, LoadingState } from './ui';
import { ProductGallery } from './product-gallery';
import { ProductMedia } from './product-media';
import { AnalysisPanel } from './analysis-panel';

type Tab = 'overview' | 'media' | 'analysis';
function asTab(value?: string): Tab {
  return value === 'media' || value === 'analysis' ? value : 'overview';
}
export function ProductDetail({ id, initialTab }: { id: string; initialTab?: string }) {
  const [product, setProduct] = useState<Product>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<Tab>(asTab(initialTab));
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
  const reload = () => setRevision((value) => value + 1);
  function selectTab(nextTab: Tab) {
    setTab(nextTab);
    window.history.replaceState(null, '', `${window.location.pathname}?tab=${nextTab}`);
  }
  if (loading) return <LoadingState />;
  if (error)
    return (
      <>
        <Link className="breadcrumb" href="/products">
          返回商品库
        </Link>
        <ErrorNotice message={error} onRetry={reload} />
      </>
    );
  if (!product)
    return (
      <EmptyState
        title="商品不存在"
        description="这个商品可能已被删除。"
        action={
          <Link className="button button-secondary" href="/products">
            返回商品库
          </Link>
        }
      />
    );
  return (
    <>
      <div className="breadcrumb">
        <Link href="/products">商品库</Link>
        <ChevronRight size={12} />
        <span>{product.sourceId}</span>
      </div>
      <div className="detail-top">
        <ProductGallery product={product} />
        <div className="detail-info">
          <div className="flex items-center gap-2">
            <Badge>Amazon</Badge>
            <Badge tone={product.aiAnalysis ? 'success' : 'warning'}>
              {product.aiAnalysis ? '已分析' : '待分析'}
            </Badge>
          </div>
          <h1>{product.title}</h1>
          <p className="detail-price">{formatPrice(product)}</p>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Star size={14} fill="#e7bc5e" stroke="#e7bc5e" />
            <span>{product.rating ?? '暂无评分'}</span>
            <span>·</span>
            <span>{product.reviewCount?.toLocaleString('zh-CN') ?? '—'} 条评分 / 评论</span>
          </div>
          <dl className="detail-meta">
            <div>
              <dt>ASIN</dt>
              <dd>{product.sourceId}</dd>
            </div>
            <div>
              <dt>店铺 / Brand</dt>
              <dd>{product.brand ?? '暂未获取'}</dd>
            </div>
            <div>
              <dt>采集时间</dt>
              <dd>{formatDate(product.createdAt)}</dd>
            </div>
            <div>
              <dt>最近更新</dt>
              <dd>{formatDate(product.updatedAt)}</dd>
            </div>
          </dl>
          <div className="detail-actions">
            <Button onClick={() => selectTab('analysis')}>
              <Sparkles size={15} />
              AI 分析
            </Button>
            <a
              className="button button-secondary"
              href={product.url}
              target="_blank"
              rel="noreferrer"
            >
              Amazon 原页面
              <ExternalLink size={13} />
            </a>
            <Button variant="ghost" onClick={reload} aria-label="刷新商品">
              <RefreshCw size={14} />
            </Button>
          </div>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="商品内容">
        {(
          [
            ['overview', 'Overview'],
            ['media', `Media · ${product.images.length + product.videos.length}`],
            ['analysis', 'AI Analysis'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className="tab"
            type="button"
            role="tab"
            id={`tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            onClick={() => selectTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && (
          <div className="overview-grid">
            <section className="panel content-panel">
              <h2>Bullet Points / 商品卖点</h2>
              {product.bulletPoints.length ? (
                <ul>
                  {product.bulletPoints.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              ) : (
                <p>页面未提供可可靠提取的 Bullet Points。</p>
              )}
            </section>
            <section className="panel content-panel">
              <h2>商品描述</h2>
              <p className="description">
                {product.description ?? '页面未提供可可靠提取的商品描述。'}
              </p>
            </section>
          </div>
        )}
        {tab === 'media' && <ProductMedia product={product} />}
        {tab === 'analysis' && <AnalysisPanel product={product} onUpdate={setProduct} />}
      </div>
    </>
  );
}
