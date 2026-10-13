'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BridgePairing } from './bridge-pairing';
import { FirstUseGuide, OPEN_SETUP_EVENT } from './first-use-guide';
import { PRODUCTSPY_VERSION } from '@productspy/shared';
import {
  ChevronRight,
  GitCompareArrows,
  LayoutDashboard,
  Library,
  Puzzle,
  ScanLine,
  ShieldCheck,
  X,
} from 'lucide-react';
import { workspaceCopy as copy } from './workspace-copy';

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [showHelp, setShowHelp] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const openHelp = useCallback(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShowHelp(true);
  }, []);
  useEffect(() => {
    window.addEventListener(OPEN_SETUP_EVENT, openHelp);
    return () => window.removeEventListener(OPEN_SETUP_EVENT, openHelp);
  }, [openHelp]);
  useEffect(() => {
    if (!showHelp) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowHelp(false);
      if (event.key !== 'Tab') return;
      const controls = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
        ) ?? []),
      ].filter((control) => control.getClientRects().length > 0);
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus();
    };
  }, [showHelp]);
  const productPage = pathname.startsWith('/products');
  const comparisonPage = pathname.startsWith('/comparisons');
  const navigation = [
    { href: '/', label: copy.common.dashboard, icon: LayoutDashboard, active: pathname === '/' },
    { href: '/products', label: copy.common.library, icon: Library, active: productPage },
    { href: '/comparisons', label: '竞品对比', icon: GitCompareArrows, active: comparisonPage },
  ];
  return (
    <div className="ws-shell">
      <div className="ws-shell-content" inert={showHelp ? true : undefined}>
        <a className="ws-skip-link" href="#workspace-content">
          {copy.shell.skip}
        </a>
        <aside className="ws-sidebar">
          <Link href="/" className="ws-brand">
            <span>
              <ScanLine size={22} />
            </span>
            ProductSpy
          </Link>
          <p className="ws-sidebar-caption">{copy.shell.caption}</p>
          <nav aria-label={copy.shell.nav} className="ws-sidebar-nav">
            {navigation.map(({ href, label, icon: Icon, active }) => (
              <Link key={href} href={href} aria-current={active ? 'page' : undefined}>
                <Icon size={18} />
                {label}
                {active && <ChevronRight size={15} className="ws-nav-chevron" />}
              </Link>
            ))}
          </nav>
          <div className="ws-sidebar-footer">
            <p>
              <ShieldCheck size={15} />
              {copy.shell.local}
            </p>
            <p>
              ProductSpy {PRODUCTSPY_VERSION} · {copy.shell.versionNote}
            </p>
          </div>
        </aside>
        <div className="ws-shell-main">
          <header className="ws-topbar">
            <div className="ws-topbar-breadcrumb">
              <span className="ws-mobile-brand">ProductSpy</span>
              <span className="ws-desktop-title">{copy.common.workspace}</span>
              <ChevronRight size={14} />
              <span>
                {comparisonPage
                  ? '竞品对比'
                  : productPage
                    ? copy.common.library
                    : copy.common.dashboard}
              </span>
            </div>
            <button
              type="button"
              onClick={openHelp}
              aria-label={copy.shell.setupLabel}
              className="button button-secondary"
            >
              <Puzzle size={16} />
              {copy.shell.setup}
            </button>
          </header>
          <nav className="ws-mobile-nav" aria-label={copy.shell.mobileNav}>
            {navigation.map(({ href, label, active }) => (
              <Link key={href} href={href} aria-current={active ? 'page' : undefined}>
                {label}
              </Link>
            ))}
          </nav>
          <main id="workspace-content" tabIndex={-1} className="ws-main-content">
            {children}
          </main>
        </div>
      </div>
      {showHelp && (
        <div className="ws-dialog-backdrop" onClick={() => setShowHelp(false)}>
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="extension-help-title"
            className="ws-setup-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ws-dialog-heading">
              <h2 id="extension-help-title">{copy.shell.helpTitle}</h2>
              <button
                type="button"
                autoFocus
                onClick={() => setShowHelp(false)}
                aria-label={copy.shell.closeHelp}
                className="ws-icon-button"
              >
                <X size={18} />
              </button>
            </div>
            <FirstUseGuide />
            <BridgePairing />
            <button
              type="button"
              onClick={() => setShowHelp(false)}
              className="button button-primary ws-dialog-done"
            >
              {copy.shell.close}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
