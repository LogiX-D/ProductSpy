'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Download,
  FolderCog,
  GitCompareArrows,
  Grid2X2,
  List,
  ListChecks,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { errorMessage, MAX_BATCH_PRODUCTS } from '@productspy/shared';
import { useLibrary } from '@/lib/use-library';
import { productRepository } from '@/lib/storage/product-api';
import { comparisonSelectionHref } from '@/lib/comparison-api';
import { Button, EmptyState, ErrorNotice, LoadingState, PageHeading } from './ui';
import { ProductCard } from './product-card';
import { OpenSetupButton } from './first-use-guide';
import { LibraryManager } from './library-manager';
import { LibraryBatchToolbar } from './library-batch-toolbar';
import { LibraryTransferDialog } from './library-transfer-dialog';
import { libraryCopy } from './library-copy';
import { workspaceCopy as copy } from './workspace-copy';
import {
  clearLibraryFilters,
  DEFAULT_LIBRARY_PREFERENCES,
  hasLibraryFilters,
  LIBRARY_PREFERENCES_KEY,
  paginateLibraryProducts,
  restoreLibraryPreferences,
  selectLibraryProducts,
  type LibraryPreferences,
} from './workspace-preferences';
import './library.css';

export function ProductsLibrary() {
  const { products, groups, tags, snapshot, loading, refreshing, error, busy, reload, mutate } =
    useLibrary();
  const [preferences, setPreferences] = useState<LibraryPreferences>(DEFAULT_LIBRARY_PREFERENCES);
  const [page, setPage] = useState(1);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<'manager' | 'transfer'>();
  const [actionError, setActionError] = useState<string>();
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const [selectionMessage, setSelectionMessage] = useState('');
  useEffect(() => {
    let restored = { ...DEFAULT_LIBRARY_PREFERENCES };
    try {
      restored = restoreLibraryPreferences(window.localStorage.getItem(LIBRARY_PREFERENCES_KEY));
    } catch {
      /* Browser preference storage is optional. */
    }
    const analysis = new URLSearchParams(window.location.search).get('analysis');
    if (analysis === 'pending' || analysis === 'analyzed') restored.analysis = analysis;
    setPreferences(restored);
  }, []);
  useEffect(() => {
    if (loading || error || !selectedIds.size) return;
    const present = new Set(products.map((product) => product.id));
    const missing = [...selectedIds].filter((id) => !present.has(id));
    if (!missing.length) return;
    setSelectedIds(new Set([...selectedIds].filter((id) => present.has(id))));
    setSelectionMessage(`已移除 ${missing.length} 个不再存在的商品选择；其余选择保留。`);
  }, [products, loading, error, selectedIds]);
  function updatePreferences(patch: Partial<LibraryPreferences>) {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    setPage(1);
    try {
      window.localStorage.setItem(LIBRARY_PREFERENCES_KEY, JSON.stringify(next));
    } catch {
      /* Denied browser storage must not block library interactions. */
    }
    if (patch.analysis !== undefined) {
      const url = new URL(window.location.href);
      if (next.analysis === 'all') url.searchParams.delete('analysis');
      else url.searchParams.set('analysis', next.analysis);
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }
  const filtered = useMemo(
    () => selectLibraryProducts(products, preferences),
    [products, preferences],
  );
  const paginated = paginateLibraryProducts(filtered, page);
  const selected = useMemo(
    () => products.filter((product) => selectedIds.has(product.id)),
    [products, selectedIds],
  );
  const filtersActive = hasLibraryFilters(preferences);
  const writesDisabled = loading || busy || Boolean(error);
  async function remove(id: string): Promise<boolean> {
    setPendingDeleteId(id);
    setActionError(undefined);
    try {
      await mutate(() => productRepository.delete(id));
      return true;
    } catch (cause) {
      console.error('[ProductSpy] Library product deletion failed', cause);
      setActionError(`删除失败：${errorMessage(cause)}。请刷新检查结果。`);
      return false;
    } finally {
      setPendingDeleteId(undefined);
    }
  }
  function select(id: string, value: boolean) {
    if (value && !selectedIds.has(id) && selected.length >= MAX_BATCH_PRODUCTS) {
      setSelectionMessage(libraryCopy.selectedLimit);
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function selectProducts(ids: string[]) {
    const combined = new Set([...selected.map((product) => product.id), ...ids]);
    if (combined.size > MAX_BATCH_PRODUCTS) {
      setSelectionMessage(libraryCopy.selectedLimit);
      return;
    }
    setSelectedIds(combined);
    setSelectionMessage('');
  }
  function successful(ids: string[]) {
    setSelectedIds((current) => new Set([...current].filter((id) => !ids.includes(id))));
  }
  return (
    <div className="ws-page ws-library">
      <PageHeading
        eyebrow={copy.library.eyebrow}
        title={copy.common.library}
        description={libraryCopy.description}
        action={
          <div className="ws-inline library-heading-actions">
            <Button
              variant="secondary"
              disabled={writesDisabled}
              onClick={() => setPanel('manager')}
            >
              <FolderCog size={15} />
              {libraryCopy.manage}
            </Button>
            <Button
              variant="secondary"
              disabled={writesDisabled}
              onClick={() => setPanel('transfer')}
            >
              <Download size={15} />
              {libraryCopy.data}
            </Button>
            <Button variant="secondary" disabled={refreshing || busy} onClick={() => void reload()}>
              <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
              {refreshing ? copy.common.refreshing : copy.common.refresh}
            </Button>
          </div>
        }
      />
      {error && (
        <>
          <ErrorNotice message={error} onRetry={() => void reload()} />
          <p className="library-offline-note" role="status">
            {libraryCopy.offline}
          </p>
        </>
      )}
      {actionError && (
        <ErrorNotice
          message={actionError}
          onRetry={() => {
            setActionError(undefined);
            void reload();
          }}
        />
      )}
      <div className="ws-library-toolbar library-toolbar">
        <div className="ws-search">
          <label className="sr-only" htmlFor="library-search">
            {copy.library.search}
          </label>
          <Search size={17} aria-hidden="true" />
          <input
            id="library-search"
            value={preferences.query}
            onChange={(event) => updatePreferences({ query: event.currentTarget.value })}
            placeholder={copy.library.searchPlaceholder}
            type="search"
            maxLength={500}
          />
          {preferences.query && (
            <button
              type="button"
              className="ws-search-clear"
              aria-label={copy.library.clearSearch}
              onClick={() => updatePreferences({ query: '' })}
            >
              <X size={15} />
            </button>
          )}
        </div>
        <label className="ws-filter">
          <span>{libraryCopy.groupFilter}</span>
          <select
            aria-label={libraryCopy.groupFilter}
            value={preferences.group}
            onChange={(event) => updatePreferences({ group: event.currentTarget.value })}
          >
            <option value="all">{libraryCopy.allGroups}</option>
            <option value="none">{libraryCopy.noGroup}</option>
            {groups.map((group) => (
              <option value={group.id} key={group.id}>
                {group.name}
              </option>
            ))}
            {preferences.group !== 'all' &&
              preferences.group !== 'none' &&
              !groups.some((group) => group.id === preferences.group) && (
                <option value={preferences.group}>分组已删除，请重新选择</option>
              )}
          </select>
        </label>
        <label className="ws-filter">
          <span>{libraryCopy.tagFilter}</span>
          <select
            aria-label={libraryCopy.tagFilter}
            value={preferences.tag}
            onChange={(event) => updatePreferences({ tag: event.currentTarget.value })}
          >
            <option value="all">{libraryCopy.allTags}</option>
            <option value="none">{libraryCopy.noTag}</option>
            {tags.map((tag) => (
              <option value={tag.id} key={tag.id}>
                {tag.name}
              </option>
            ))}
            {preferences.tag !== 'all' &&
              preferences.tag !== 'none' &&
              !tags.some((tag) => tag.id === preferences.tag) && (
                <option value={preferences.tag}>标签已删除，请重新选择</option>
              )}
          </select>
        </label>
        <label className="ws-filter">
          <span>{copy.library.analysis}</span>
          <select
            aria-label={copy.library.analysis}
            value={preferences.analysis}
            onChange={(event) =>
              updatePreferences({
                analysis: event.currentTarget.value as LibraryPreferences['analysis'],
              })
            }
          >
            <option value="all">{copy.library.allAnalysis}</option>
            <option value="pending">{copy.common.pending}</option>
            <option value="analyzed">{copy.common.analyzed}</option>
          </select>
        </label>
        <label className="ws-filter">
          <span>{copy.library.source}</span>
          <select
            aria-label={copy.library.source}
            value={preferences.source}
            onChange={(event) =>
              updatePreferences({
                source: event.currentTarget.value as LibraryPreferences['source'],
              })
            }
          >
            <option value="all">{copy.library.allSources}</option>
            <option value="amazon">{copy.common.amazon}</option>
          </select>
        </label>
        <label className="ws-filter">
          <span>{copy.library.sort}</span>
          <select
            aria-label={copy.library.sort}
            value={preferences.sort}
            onChange={(event) =>
              updatePreferences({ sort: event.currentTarget.value as LibraryPreferences['sort'] })
            }
          >
            <option value="updated-desc">{copy.library.updatedDesc}</option>
            <option value="collected-desc">{copy.library.collectedDesc}</option>
            <option value="collected-asc">{copy.library.collectedAsc}</option>
            <option value="title-asc">{copy.library.titleAsc}</option>
          </select>
        </label>
      </div>
      <div className="ws-library-results">
        <div className="ws-inline">
          <p className="ws-result-count" role="status">
            {copy.library.count(filtered.length, products.length)}
          </p>
          {filtersActive && (
            <Button
              variant="ghost"
              onClick={() => updatePreferences(clearLibraryFilters(preferences))}
            >
              <X size={14} />
              {copy.library.clearFilters}
            </Button>
          )}
        </div>
        <div className="ws-inline">
          <Button
            variant={selecting ? 'primary' : 'secondary'}
            disabled={loading || busy || (!selecting && !products.length)}
            aria-pressed={selecting}
            onClick={() => {
              setSelecting(!selecting);
              setSelectedIds(new Set());
              setSelectionMessage('');
            }}
          >
            <ListChecks size={15} />
            {selecting ? libraryCopy.finishSelection : libraryCopy.multiSelect}
          </Button>
          <div className="ws-view-toggle" role="group" aria-label={copy.library.view}>
            <button
              type="button"
              aria-label={copy.library.grid}
              aria-pressed={preferences.layout === 'grid'}
              onClick={() => updatePreferences({ layout: 'grid' })}
            >
              <Grid2X2 size={17} />
            </button>
            <button
              type="button"
              aria-label={copy.library.list}
              aria-pressed={preferences.layout === 'list'}
              onClick={() => updatePreferences({ layout: 'list' })}
            >
              <List size={17} />
            </button>
          </div>
        </div>
      </div>
      {selecting && (
        <>
          <div className="library-selection-row">
            {selected.length >= 2 && selected.length <= 5 && !writesDisabled ? (
              <Link
                className="button button-primary"
                href={comparisonSelectionHref(selected.map((product) => product.id))}
              >
                <GitCompareArrows size={15} />
                加入竞品对比
              </Link>
            ) : (
              <Button variant="secondary" disabled title="请选择 2–5 个商品">
                <GitCompareArrows size={15} />
                加入竞品对比（2–5 个）
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={writesDisabled || !paginated.products.length}
              onClick={() => selectProducts(paginated.products.map((product) => product.id))}
            >
              {libraryCopy.selectPage}
            </Button>
            <Button
              variant="ghost"
              disabled={writesDisabled || !filtered.length || filtered.length > MAX_BATCH_PRODUCTS}
              onClick={() => selectProducts(filtered.map((product) => product.id))}
            >
              {libraryCopy.selectFiltered}
            </Button>
            <p>跨页已选商品仍保留；切换筛选不会自动清除选择。</p>
          </div>
          {selectionMessage && <p role="status">{selectionMessage}</p>}
          <LibraryBatchToolbar
            selected={selected}
            snapshot={snapshot}
            disabled={writesDisabled}
            mutate={mutate}
            onSuccess={successful}
            onClear={() => {
              setSelectedIds(new Set());
              setSelectionMessage('');
            }}
          />
        </>
      )}
      {loading ? (
        <LoadingState />
      ) : products.length === 0 ? (
        <EmptyState
          title={error ? copy.library.unavailable : copy.library.emptyTitle}
          description={error ? copy.library.unavailableDescription : copy.library.emptyDescription}
          action={
            error ? (
              <Button variant="secondary" onClick={() => void reload()}>
                {copy.common.refresh}
              </Button>
            ) : (
              <div className="ws-inline">
                <OpenSetupButton />
                <Button variant="secondary" onClick={() => setPanel('transfer')}>
                  {libraryCopy.importEmpty}
                </Button>
              </div>
            )
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={copy.library.noResults}
          description={copy.library.noResultsDescription}
        />
      ) : (
        <>
          <div className={preferences.layout === 'grid' ? 'ws-products-grid' : 'ws-products-list'}>
            {paginated.products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                layout={preferences.layout}
                onDelete={selecting ? undefined : remove}
                deleting={pendingDeleteId === product.id}
                deleteDisabled={writesDisabled || Boolean(pendingDeleteId)}
                selectable={selecting}
                selected={selectedIds.has(product.id)}
                onSelect={select}
                selectionDisabled={writesDisabled}
                groups={groups}
                tags={tags}
              />
            ))}
          </div>
          <nav className="library-pagination" aria-label="商品分页">
            <p>{libraryCopy.perPage}</p>
            <div className="ws-inline">
              <Button
                variant="secondary"
                disabled={paginated.currentPage === 1}
                onClick={() => setPage(paginated.currentPage - 1)}
              >
                {libraryCopy.previous}
              </Button>
              <span role="status">
                {libraryCopy.page(paginated.currentPage, paginated.totalPages)}
              </span>
              <Button
                variant="secondary"
                disabled={paginated.currentPage === paginated.totalPages}
                onClick={() => setPage(paginated.currentPage + 1)}
              >
                {libraryCopy.next}
              </Button>
            </div>
          </nav>
        </>
      )}
      {!loading && products.length > 0 && <p className="ws-sync-note">{copy.library.syncNote}</p>}
      {panel === 'manager' && (
        <LibraryManager snapshot={snapshot} mutate={mutate} onClose={() => setPanel(undefined)} />
      )}
      {panel === 'transfer' && (
        <LibraryTransferDialog mutate={mutate} onClose={() => setPanel(undefined)} />
      )}
    </div>
  );
}
