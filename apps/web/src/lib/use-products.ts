'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, type Product } from '@productspy/shared';
import { loadProducts, productRepository } from './storage/product-api';

/** Keeps the workspace in sync with saves made by the extension. */
export function useProducts() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const mutating = useRef(false);
  const generation = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    if (!mounted.current || inFlight.current || mutating.current) return;
    inFlight.current = true;
    const request = ++generation.current;
    setRefreshing(true);
    try {
      const result = await loadProducts();
      if (!mounted.current || request !== generation.current) return;
      setProducts(result.products);
      setError(result.error);
    } catch (cause) {
      console.error('[ProductSpy] Workspace refresh failed', cause);
      if (mounted.current && request === generation.current) setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current && request === generation.current) {
        setLoading(false);
        setRefreshing(false);
      } else if (mounted.current && !mutating.current) {
        // A deletion may invalidate a concurrent read. Refresh from the
        // repository after the mutation has finished.
        void reload();
      }
    }
  }, []);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    if (!mounted.current || mutating.current) return false;
    mutating.current = true;
    ++generation.current;
    setPendingDeleteId(id);
    setRefreshing(false);
    try {
      await productRepository.delete(id);
      if (mounted.current) {
        setProducts((current) => current.filter((product) => product.id !== id));
        setError(undefined);
      }
      return true;
    } catch (cause) {
      console.error('[ProductSpy] Product deletion failed', cause);
      if (mounted.current) setError(`删除失败：${errorMessage(cause)}`);
      return false;
    } finally {
      mutating.current = false;
      if (mounted.current) {
        setPendingDeleteId(undefined);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    const refreshOnFocus = () => void reload();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 5000);
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [reload]);

  return { products, loading, refreshing, error, reload, remove, pendingDeleteId };
}
