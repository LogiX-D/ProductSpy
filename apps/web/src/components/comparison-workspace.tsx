'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, GitCompareArrows, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import {
  errorMessage,
  exportComparisonCsv,
  exportComparisonMarkdown,
  type ComparisonPlan,
  type Product,
} from '@productspy/shared';
import {
  createComparison,
  deleteComparison,
  listComparisons,
  updateComparison,
} from '../lib/comparison-api';
import { productRepository } from '../lib/storage/product-api';
import { downloadLibraryFile } from '../lib/library-api';
import { ComparisonTable } from './comparison-table';
import { ComparisonAnalysisPanel } from './comparison-analysis';
import { ComparisonBackupDialog } from './comparison-backup';
import { LibraryDialog } from './library-dialog';
import { Badge, Button, EmptyState, ErrorNotice, LoadingState, PageHeading } from './ui';
import './library.css';
import './comparison.css';

export function ComparisonWorkspace() {
  const [products, setProducts] = useState<Product[]>([]);
  const [plans, setPlans] = useState<ComparisonPlan[]>([]);
  const [plan, setPlan] = useState<ComparisonPlan>();
  const [selected, setSelected] = useState<Product[]>([]);
  const [name, setName] = useState('新的竞品对比');
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<'delete' | 'refresh' | 'discard'>();
  const [nextPlanId, setNextPlanId] = useState<string>();
  const [showBackup, setShowBackup] = useState(false);
  const validSelection = selected.length >= 2 && selected.length <= 5;
  const modified = Boolean(
    plan &&
    (name !== plan.name ||
      JSON.stringify(selected.map((product) => product.id)) !==
        JSON.stringify(plan.products.map((product) => product.id))),
  );
  const locked = loading || busy || editing;
  const currentMap = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );
  const available = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return products
      .filter((product) =>
        `${product.title} ${product.sourceId} ${product.brand ?? ''}`
          .toLocaleLowerCase()
          .includes(search),
      )
      .slice(0, 60);
  }, [products, query]);
  const applyPlan = useCallback((value: ComparisonPlan) => {
    setPlan(value);
    setName(value.name);
    setSelected(value.products);
    setPlans((current) =>
      [value, ...current.filter((item) => item.id !== value.id)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    );
    const url = new URL(window.location.href);
    url.searchParams.delete('products');
    url.searchParams.set('plan', value.id);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, []);
  const onEditing = useCallback((value: boolean) => setEditing(value), []);
  async function reload(initial = false) {
    if (initial) setLoading(true);
    else setBusy(true);
    setError('');
    try {
      const [freshProducts, freshPlans] = await Promise.all([
        productRepository.list(),
        listComparisons(),
      ]);
      setProducts(freshProducts);
      setPlans(freshPlans);
      if (initial) {
        const params = new URLSearchParams(window.location.search);
        const requested = freshPlans.find((item) => item.id === params.get('plan'));
        if (requested) applyPlan(requested);
        else {
          const ids = (params.get('products') ?? '').split(',').filter(Boolean).slice(0, 5);
          if (ids.length) {
            const wanted = new Set(ids);
            setSelected(freshProducts.filter((product) => wanted.has(product.id)));
            setMessage(
              ids.some((id) => !freshProducts.some((product) => product.id === id))
                ? '部分选择已不在商品库中，已载入仍可用的商品。'
                : '已从商品库载入选择；添加至少 2 个商品后保存方案。',
            );
          } else if (params.has('plan')) setMessage('该方案已不存在，请载入其他方案或新建对比。');
        }
      } else setMessage('商品库和方案列表已刷新；当前对比快照保持不变。');
    } catch (cause) {
      setError(`无法读取对比资料：${errorMessage(cause)}。当前已载入内容仍保留。`);
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }
  useEffect(() => {
    void reload(true); /* Load the initial URL once; subsequent updates remain explicit. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!modified && !(selected.length > 0 && !plan)) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [modified, selected.length, plan]);
  function changeSelection(product: Product, checked: boolean) {
    setError('');
    setMessage('');
    if (!checked) {
      setSelected((items) => items.filter((item) => item.id !== product.id));
      return;
    }
    if (selected.length >= 5) {
      setMessage('一次最多对比 5 个商品，请先移除一个。');
      return;
    }
    if (selected.some((item) => item.sourceId === product.sourceId)) {
      setMessage('同一 ASIN 只能加入一次，请选择其他商品。');
      return;
    }
    setSelected((items) => [...items, product]);
  }
  async function save() {
    if (locked || !validSelection || !name.trim()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const updated = plan
        ? await updateComparison(plan, {
            name: name.trim(),
            productIds: selected.map((product) => product.id),
          })
        : await createComparison(
            name.trim(),
            selected.map((product) => product.id),
          );
      applyPlan(updated);
      setMessage('对比方案已保存到本机。商品原始资料和已有 AI 历史保持完整。');
    } catch (cause) {
      setError(`保存失败：${errorMessage(cause)}。当前选择仍保留，可重试或复制资料。`);
    } finally {
      setBusy(false);
    }
  }
  function switchPlan(id?: string) {
    if (locked) return;
    if (modified || (!plan && selected.length > 0)) {
      setNextPlanId(id ?? '');
      setDialog('discard');
      return;
    }
    performSwitch(id);
  }
  function performSwitch(id?: string) {
    setError('');
    setMessage('');
    const value = plans.find((item) => item.id === id);
    if (value) applyPlan(value);
    else {
      setPlan(undefined);
      setSelected([]);
      setName('新的竞品对比');
      const url = new URL(window.location.href);
      url.search = '';
      window.history.replaceState(null, '', url.pathname);
    }
    setDialog(undefined);
  }
  async function confirmOperation() {
    if (dialog === 'discard') {
      performSwitch(nextPlanId);
      return;
    }
    if (!plan || busy) return;
    setBusy(true);
    setError('');
    try {
      if (dialog === 'delete') {
        await deleteComparison(plan);
        setPlans((items) => items.filter((item) => item.id !== plan.id));
        setPlan(undefined);
        setSelected([]);
        setName('新的竞品对比');
        const url = new URL(window.location.href);
        url.search = '';
        window.history.replaceState(null, '', url.pathname);
        setMessage('对比方案已删除，商品库和商品分析未受影响。');
      } else if (dialog === 'refresh') {
        const updated = await updateComparison(plan, { refreshSnapshots: true });
        applyPlan(updated);
        setMessage(
          '已刷新仍存在商品的页面快照，已删除商品的原快照继续保留。已有 AI 分析可能需要按新资料重新核查。',
        );
      }
      setDialog(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function exportPlan(format: 'csv' | 'markdown') {
    if (!plan) return;
    downloadLibraryFile({
      filename: `ProductSpy-comparison-${plan.id.slice(0, 8)}.${format === 'csv' ? 'csv' : 'md'}`,
      mimeType: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8',
      content: format === 'csv' ? exportComparisonCsv(plan) : exportComparisonMarkdown(plan),
      count: plan.products.length,
    });
    setMessage('已交给浏览器保存文件；如有未保存的改动，请先保存方案再导出。');
  }
  if (loading) return <LoadingState />;
  return (
    <div className="ws-page comparison-workspace">
      <PageHeading
        title="竞品对比"
        description="并排查看 2–5 个 Amazon 商品的历史采集资料，保留独立快照与分析。"
        action={
          <div className="ws-inline">
            <Button variant="secondary" disabled={locked} onClick={() => switchPlan()}>
              <Plus size={15} />
              新建对比
            </Button>
            <Button variant="secondary" disabled={locked} onClick={() => setShowBackup(true)}>
              <Download size={15} />
              备份与恢复
            </Button>
            <Button variant="secondary" disabled={locked} onClick={() => void reload()}>
              <RefreshCw size={15} />
              刷新列表
            </Button>
          </div>
        }
      />
      {error && <ErrorNotice message={error} onRetry={() => void reload()} />}
      {message && (
        <p className="comparison-notice" role="status">
          {message}
        </p>
      )}
      <div className="comparison-controls">
        <label className="ws-filter">
          <span>历史方案</span>
          <select
            aria-label="历史对比方案"
            value={plan?.id ?? ''}
            disabled={locked}
            onChange={(event) => switchPlan(event.currentTarget.value)}
          >
            <option value="">新建方案</option>
            {plans.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.products.length} 个商品
              </option>
            ))}
          </select>
        </label>
        <label className="ws-filter comparison-name">
          <span>方案名称</span>
          <input
            aria-label="对比方案名称"
            maxLength={120}
            value={name}
            disabled={locked}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <Button
          disabled={locked || !validSelection || !name.trim() || (Boolean(plan) && !modified)}
          onClick={() => void save()}
        >
          <Save size={15} />
          {busy ? '正在保存…' : '保存方案'}
        </Button>
        {plan && (
          <Button variant="ghost" disabled={locked} onClick={() => setDialog('delete')}>
            <Trash2 size={15} />
            删除方案
          </Button>
        )}
      </div>
      <details className="comparison-picker" open>
        <summary>
          <GitCompareArrows size={16} />
          <strong>选择对比商品</strong>
          <span>已选 {selected.length} / 5</span>
        </summary>
        <div className="ws-search">
          <Search size={16} />
          <input
            aria-label="搜索可选对比商品"
            type="search"
            placeholder="搜索名称、ASIN 或品牌"
            value={query}
            maxLength={500}
            onChange={(event) => setQuery(event.currentTarget.value)}
            disabled={locked}
          />
        </div>
        {!products.length ? (
          <p className="comparison-boundary">
            商品库还没有商品。<Link href="/products">先采集或导入商品</Link>，然后返回对比。
          </p>
        ) : (
          <div className="comparison-picker-list">
            {available.map((product) => (
              <label key={product.id}>
                <input
                  type="checkbox"
                  aria-label={`对比 ${product.sourceId}`}
                  checked={selected.some((item) => item.id === product.id)}
                  disabled={locked}
                  onChange={(event) => changeSelection(product, event.currentTarget.checked)}
                />
                <span>
                  <strong>{product.title}</strong>
                  <small>
                    {product.sourceId} · {product.brand ?? '品牌未知'}
                  </small>
                </span>
              </label>
            ))}
            {!available.length && <p>没有匹配的商品，请调整搜索。</p>}
          </div>
        )}
        {available.length === 60 && (
          <p className="muted">显示前 60 个匹配商品，请搜索以缩小范围。</p>
        )}
      </details>
      {selected.length ? (
        <>
          <div className="comparison-table-toolbar">
            <div className="ws-inline">
              <Badge>
                {selected.length} 个商品{modified || !plan ? ' · 未保存改动' : ' · 已保存快照'}
              </Badge>
              <label>
                <input
                  type="checkbox"
                  checked={highlight}
                  onChange={(event) => setHighlight(event.currentTarget.checked)}
                />
                高亮差异
              </label>
            </div>
            <div className="ws-inline">
              {plan && (
                <>
                  <Button
                    variant="secondary"
                    disabled={locked || modified}
                    onClick={() => setDialog('refresh')}
                  >
                    <RefreshCw size={14} />
                    刷新商品快照
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={locked || modified}
                    onClick={() => exportPlan('csv')}
                  >
                    <Download size={14} />
                    CSV
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={locked || modified}
                    onClick={() => exportPlan('markdown')}
                  >
                    Markdown
                  </Button>
                </>
              )}
            </div>
          </div>
          <p className="comparison-boundary">
            横向滚动查看所有商品。差异高亮只表示资料不同，不代表优劣；不同货币不直接比较高低，价格不是实时值。
          </p>
          <ComparisonTable
            products={selected}
            currentProducts={products}
            highlight={highlight}
            disabled={locked}
            onRemove={(id) => setSelected((items) => items.filter((item) => item.id !== id))}
          />
          {!validSelection && (
            <p className="comparison-notice" role="status">
              请再选择一个不同 ASIN 的商品；保存方案需要 2–5 个商品。
            </p>
          )}
          {plan && !modified ? (
            <ComparisonAnalysisPanel
              key={plan.id}
              plan={plan}
              onUpdate={applyPlan}
              onEditing={onEditing}
            />
          ) : (
            <p className="comparison-boundary">
              先保存当前对比方案，再进行 AI 对比分析。{plan && '原方案的分析与历史仍保留。'}
            </p>
          )}
          {selected.some((item) => !currentMap.has(item.id)) && (
            <p className="comparison-boundary">
              已删除商品的独立快照仍可查看和分析。刷新快照仅更新仍存在的商品。
            </p>
          )}
        </>
      ) : (
        <EmptyState
          title="从两件商品开始比较"
          description="在上方选择商品，或在商品库多选 2–5 个商品后点击“加入竞品对比”。保存方案后可随时重新载入。"
          action={
            <Link className="button button-secondary" href="/products">
              打开商品库
            </Link>
          }
        />
      )}
      {dialog && (
        <LibraryDialog
          title={
            dialog === 'delete'
              ? '删除此对比方案？'
              : dialog === 'refresh'
                ? '刷新保存的商品快照？'
                : '放弃未保存的对比选择？'
          }
          busy={busy}
          onClose={() => setDialog(undefined)}
        >
          <p>
            {dialog === 'delete'
              ? '将删除此方案及其 AI 对比分析历史。商品库、商品分析和其他方案不会被删除。请先导出需要保留的资料。'
              : dialog === 'refresh'
                ? '用商品库当前资料更新此方案的快照。不存在的商品仍保留原快照；已有 AI 结果和历史不会清除，请按新资料重新核查。'
                : '当前方案名称或商品选择尚未保存。继续会放弃这些改动，已保存的方案与分析仍保留。'}
          </p>
          <div className="library-dialog-footer">
            <Button
              variant={dialog === 'delete' ? 'danger' : 'primary'}
              disabled={busy}
              onClick={() => void confirmOperation()}
            >
              {dialog === 'delete'
                ? '确认删除方案'
                : dialog === 'refresh'
                  ? '确认刷新快照'
                  : '放弃改动并继续'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setDialog(undefined)}>
              取消
            </Button>
          </div>
        </LibraryDialog>
      )}
      {showBackup && (
        <ComparisonBackupDialog
          onClose={() => setShowBackup(false)}
          onRestored={() => void reload()}
        />
      )}
    </div>
  );
}
