'use client';

import { useMemo, useState } from 'react';
import { Grid2X2, List, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import { useProducts } from '@/lib/use-products';
import { Button, EmptyState, ErrorNotice, LoadingState, PageHeading } from './ui';
import { ProductCard } from './product-card';
import { OpenSetupButton } from './first-use-guide';

export function ProductsLibrary() {
  const { products, loading, refreshing, error, reload, remove, pendingDeleteId } = useProducts();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return products.filter(
      (product) =>
        (source === 'all' || product.source === source) &&
        (!term ||
          [product.title, product.brand, product.sourceId].some((value) =>
            value?.toLocaleLowerCase().includes(term),
          )),
    );
  }, [products, query, source]);

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="本机素材库"
        title="商品库"
        description="收集竞品素材，为下一条内容找到方向。"
        action={
          <Button variant="secondary" disabled={refreshing} onClick={() => void reload()}>
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
            刷新
          </Button>
        }
      />
      {error && <ErrorNotice message={error} onRetry={() => void reload()} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <label className="relative w-full max-w-sm">
            <span className="sr-only">搜索商品</span>
            <Search
              size={17}
              className="pointer-events-none absolute left-3 top-3 text-slate-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题、品牌或 ASIN…"
              className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/10"
            />
          </label>
          <label className="relative">
            <span className="sr-only">筛选来源</span>
            <SlidersHorizontal
              size={15}
              className="pointer-events-none absolute left-3 top-3 text-slate-400"
            />
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="h-10 rounded-lg border border-slate-200 bg-white pl-9 pr-7 text-sm text-slate-600 outline-none focus:border-teal-500"
            >
              <option value="all">全部来源</option>
              <option value="amazon">Amazon</option>
            </select>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400">{filtered.length} 个商品</span>
          <div className="flex rounded-lg border border-slate-200 bg-white p-1">
            <button
              type="button"
              aria-label="网格视图"
              aria-pressed={layout === 'grid'}
              onClick={() => setLayout('grid')}
              className={`rounded-md p-1.5 ${layout === 'grid' ? 'bg-teal-50 text-teal-700' : 'text-slate-400 hover:text-slate-600'}`}
            >
              <Grid2X2 size={17} />
            </button>
            <button
              type="button"
              aria-label="列表视图"
              aria-pressed={layout === 'list'}
              onClick={() => setLayout('list')}
              className={`rounded-md p-1.5 ${layout === 'list' ? 'bg-teal-50 text-teal-700' : 'text-slate-400 hover:text-slate-600'}`}
            >
              <List size={17} />
            </button>
          </div>
        </div>
      </div>
      {loading ? (
        <LoadingState />
      ) : products.length === 0 ? (
        <EmptyState
          title="还没有采集商品"
          description="打开 Amazon 商品页面，通过 ProductSpy 插件保存第一个商品。"
          action={<OpenSetupButton />}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有找到匹配商品"
          description="试试其他标题、品牌或 ASIN，或清除筛选。"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery('');
                setSource('all');
              }}
            >
              清除筛选
            </Button>
          }
        />
      ) : (
        <div
          className={
            layout === 'grid'
              ? 'grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'
              : 'space-y-3'
          }
        >
          {filtered.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              layout={layout}
              onDelete={remove}
              deleting={pendingDeleteId === product.id}
              deleteDisabled={Boolean(pendingDeleteId)}
            />
          ))}
        </div>
      )}
      {!loading && products.length > 0 && (
        <p className="text-center text-xs text-slate-400">商品来自本机采集 · 每 5 秒自动同步</p>
      )}
    </div>
  );
}
