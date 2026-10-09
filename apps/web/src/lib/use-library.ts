'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, type LibrarySnapshot } from '@productspy/shared';
import { fetchLibrary } from './library-api';
import { webCache } from './storage/web-storage';

/** The localhost snapshot is authoritative; an offline cache is strictly read-only. */
export function useLibrary() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>({ products: [], groups: [], tags: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const reading = useRef(false);
  const mutating = useRef(false);
  const online = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    if (!mounted.current || reading.current || mutating.current) return;
    reading.current = true;
    const request = ++generation.current;
    setRefreshing(true);
    try {
      const next = await fetchLibrary();
      if (!mounted.current || request !== generation.current) return;
      online.current = true;
      setSnapshot(next);
      setError(undefined);
    } catch (cause) {
      console.error('[ProductSpy] Library refresh failed', cause);
      if (!mounted.current || request !== generation.current) return;
      online.current = false;
      setError(errorMessage(cause));
      try {
        const cached = await webCache.list();
        if (mounted.current && request === generation.current) {
          setSnapshot((current) => ({ ...current, products: cached }));
          setError(`${errorMessage(cause)}。当前显示本机缓存。`);
        }
      } catch {
        // Keep the last displayed snapshot when both local sources are unavailable.
      }
    } finally {
      reading.current = false;
      if (mounted.current && request === generation.current) {
        setLoading(false);
        setRefreshing(false);
      } else if (mounted.current && !mutating.current) void reload();
    }
  }, []);
  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      if (!mounted.current || mutating.current) throw new Error('正在处理其他操作，请稍后再试');
      if (!online.current) throw new Error('工作台尚未连接，请刷新后再操作');
      mutating.current = true;
      ++generation.current;
      setBusy(true);
      setRefreshing(false);
      try {
        return await operation();
      } finally {
        mutating.current = false;
        if (mounted.current) {
          setBusy(false);
          void reload();
        }
      }
    },
    [reload],
  );
  useEffect(() => {
    mounted.current = true;
    void reload();
    const focus = () => void reload();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 5000);
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', focus);
    };
  }, [reload]);
  return { ...snapshot, snapshot, loading, refreshing, error, busy, reload, mutate };
}
