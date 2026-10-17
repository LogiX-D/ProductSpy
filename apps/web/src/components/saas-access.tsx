'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ApiRequestError } from '@productspy/shared';
import {
  ACCOUNT_CHANGED_EVENT,
  ACCOUNT_STORAGE_EVENT,
  clearAccountSession,
  getAccountSession,
  refreshAccountSession,
} from '../lib/session';
import type { AccountSession } from '../lib/saas-types';
import { Button, ErrorNotice, LoadingState } from './ui';

const AccountContext = createContext<AccountSession | undefined>(undefined);
export function useAccount() {
  return useContext(AccountContext);
}

export function SaasAccess({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [account, setAccount] = useState<AccountSession>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const sync = () => {
      if (active) setAccount(getAccountSession());
    };
    const verify = () => {
      void refreshAccountSession(true)
        .then((next) => {
          if (active) {
            setAccount(next);
            setError('');
          }
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setAccount(undefined);
          if (cause instanceof ApiRequestError && cause.status === 401) {
            router.replace(`/login?next=${encodeURIComponent(pathname + window.location.search)}`);
          } else setError(cause instanceof Error ? cause.message : '账号验证失败，请重试。');
        });
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== ACCOUNT_STORAGE_EVENT) return;
      clearAccountSession();
      verify();
    };
    const changed = () => {
      sync();
      if (!getAccountSession())
        router.replace(`/login?next=${encodeURIComponent(pathname + window.location.search)}`);
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') verify();
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, changed);
    window.addEventListener('storage', storage);
    window.addEventListener('focus', verify);
    document.addEventListener('visibilitychange', visibility);
    verify();
    return () => {
      active = false;
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, changed);
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', verify);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [pathname, router, attempt]);
  if (!account)
    return (
      <div className="saas-access-state">
        {error ? (
          <>
            <ErrorNotice message={error} />
            <Button onClick={() => setAttempt((current) => current + 1)}>重新验证账号</Button>
          </>
        ) : (
          <LoadingState />
        )}
      </div>
    );
  return (
    <AccountContext.Provider value={account} key={account.user.id}>
      {children}
    </AccountContext.Provider>
  );
}
