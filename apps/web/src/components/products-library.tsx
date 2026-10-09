'use client';

import { useEffect, useMemo, useState } from 'react';
import { Grid2X2, List, RefreshCw, Search, X } from 'lucide-react';
import { useProducts } from '@/lib/use-products';
import { Button, EmptyState, ErrorNotice, LoadingState, PageHeading } from './ui';
import { ProductCard } from './product-card';
import { OpenSetupButton } from './first-use-guide';
import { workspaceCopy as copy } from './workspace-copy';
import {
  clearLibraryFilters,
  DEFAULT_LIBRARY_PREFERENCES,
  hasLibraryFilters,
  LIBRARY_PREFERENCES_KEY,
  restoreLibraryPreferences,
  selectLibraryProducts,
  type LibraryPreferences,
} from './workspace-preferences';

export function ProductsLibrary() {
  const { products, loading, refreshing, error, reload, remove, pendingDeleteId } = useProducts();
  const [preferences, setPreferences] = useState<LibraryPreferences>(DEFAULT_LIBRARY_PREFERENCES);
  useEffect(() => {
    let restored = { ...DEFAULT_LIBRARY_PREFERENCES };
    try {
      restored = restoreLibraryPreferences(window.localStorage.getItem(LIBRARY_PREFERENCES_KEY));
    } catch {
      // The library remains usable when browser storage is unavailable.
    }
    const analysis = new URLSearchParams(window.location.search).get('analysis');
    if (analysis === 'pending' || analysis === 'analyzed') restored.analysis = analysis;
    setPreferences(restored);
  }, []);
  function updatePreferences(patch: Partial<LibraryPreferences>) {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    try {
      window.localStorage.setItem(LIBRARY_PREFERENCES_KEY, JSON.stringify(next));
    } catch {
      // A denied storage write must not block search, sorting or navigation.
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
  const filtersActive = hasLibraryFilters(preferences);

  return (
    <div className="ws-page ws-library">
      <PageHeading
        eyebrow={copy.library.eyebrow}
        title={copy.common.library}
        description={copy.library.description}
        action={
          <Button variant="secondary" disabled={refreshing} onClick={() => void reload()}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
            {refreshing ? copy.common.refreshing : copy.common.refresh}
          </Button>
        }
      />
      {error && <ErrorNotice message={error} onRetry={() => void reload()} />}
      <div className="ws-library-toolbar">
        <div className="ws-search">
          <label className="sr-only" htmlFor="library-search">
            {copy.library.search}
          </label>
          <Search size={17} aria-hidden="true" />
          <input
            id="library-search"
            value={preferences.query}
            onChange={(event) => updatePreferences({ query: event.target.value })}
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
          <span>{copy.library.source}</span>
          <select
            value={preferences.source}
            onChange={(event) =>
              updatePreferences({ source: event.target.value as LibraryPreferences['source'] })
            }
          >
            <option value="all">{copy.library.allSources}</option>
            <option value="amazon">{copy.common.amazon}</option>
          </select>
        </label>
        <label className="ws-filter">
          <span>{copy.library.analysis}</span>
          <select
            value={preferences.analysis}
            onChange={(event) =>
              updatePreferences({ analysis: event.target.value as LibraryPreferences['analysis'] })
            }
          >
            <option value="all">{copy.library.allAnalysis}</option>
            <option value="pending">{copy.common.pending}</option>
            <option value="analyzed">{copy.common.analyzed}</option>
          </select>
        </label>
        <label className="ws-filter">
          <span>{copy.library.sort}</span>
          <select
            value={preferences.sort}
            onChange={(event) =>
              updatePreferences({ sort: event.target.value as LibraryPreferences['sort'] })
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
              <OpenSetupButton />
            )
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={copy.library.noResults}
          description={copy.library.noResultsDescription}
        />
      ) : (
        <div className={preferences.layout === 'grid' ? 'ws-products-grid' : 'ws-products-list'}>
          {filtered.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              layout={preferences.layout}
              onDelete={remove}
              deleting={pendingDeleteId === product.id}
              deleteDisabled={Boolean(pendingDeleteId)}
            />
          ))}
        </div>
      )}
      {!loading && products.length > 0 && <p className="ws-sync-note">{copy.library.syncNote}</p>}
    </div>
  );
}
