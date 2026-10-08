'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BridgePairing } from './bridge-pairing';
import { FirstUseGuide, OPEN_SETUP_EVENT } from './first-use-guide';
import { PRODUCTSPY_VERSION } from '@productspy/shared';
import {
  ArrowUpRight,
  ChevronRight,
  LayoutDashboard,
  Library,
  Puzzle,
  ScanLine,
  ShieldCheck,
  X,
} from 'lucide-react';

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowHelp(false);
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input, a[href]',
      );
      if (!controls?.length) return;
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
      previousFocus.current?.focus();
    };
  }, [showHelp]);
  const productPage = pathname.startsWith('/products');
  const navigation = [
    { href: '/', label: '首页', icon: LayoutDashboard, active: !productPage },
    { href: '/products', label: '商品库', icon: Library, active: productPage },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[218px] flex-col bg-[#132b35] text-white md:flex">
        <Link
          href="/"
          className="flex h-20 items-center gap-3 px-6 text-xl font-semibold tracking-tight"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-400/15 text-teal-300">
            <ScanLine size={22} />
          </span>
          ProductSpy
        </Link>
        <div className="px-6 pb-7 text-[10px] font-semibold uppercase tracking-[.2em] text-slate-400">
          商品素材与内容分析
        </div>
        <nav aria-label="主导航" className="space-y-1 px-3">
          {navigation.map(({ href, label, icon: Icon, active }) => (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm transition-colors ${active ? 'bg-white/10 font-medium text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}
            >
              <Icon size={18} />
              {label}
              {active && <ChevronRight size={15} className="ml-auto text-teal-300" />}
            </Link>
          ))}
        </nav>
        <div className="mt-auto px-4 pb-5">
          <div className="mb-5 flex items-center gap-2 border-b border-white/10 px-2 pb-4 text-xs text-slate-400">
            <ShieldCheck size={15} className="text-teal-300" />
            本地优先 · 本机素材库
          </div>
          <button
            type="button"
            onClick={openHelp}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm text-slate-300 hover:text-white"
          >
            <Puzzle size={18} />
            安装 Chrome 扩展
            <ArrowUpRight size={15} className="ml-auto" />
          </button>
          <p className="mt-4 px-2 text-[11px] text-slate-500">
            ProductSpy {PRODUCTSPY_VERSION} · 仅支持 Amazon
          </p>
        </div>
      </aside>
      <div className="md:pl-[218px]">
        <header className="flex h-[65px] items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 sm:px-8">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="font-semibold text-slate-900 md:hidden">ProductSpy</span>
            <span className="hidden md:inline">工作台</span>
            <ChevronRight size={14} />
            <span className="text-slate-800">{productPage ? '商品库' : '首页'}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-xs text-slate-500 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-500" />
              本地工作空间
            </span>
            <button
              type="button"
              onClick={openHelp}
              aria-label="查看扩展安装说明"
              className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50"
            >
              <Puzzle size={17} />
            </button>
          </div>
        </header>
        <nav
          className="flex gap-4 border-b border-slate-200 bg-white px-5 py-3 md:hidden"
          aria-label="移动端主导航"
        >
          {navigation.map(({ href, label, active }) => (
            <Link
              key={href}
              href={href}
              className={`text-sm ${active ? 'font-semibold text-teal-700' : 'text-slate-500'}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <main className="mx-auto max-w-[1440px] p-5 sm:p-8 lg:p-10">{children}</main>
      </div>
      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-5"
          onClick={() => setShowHelp(false)}
        >
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="extension-help-title"
            className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="mb-4 rounded-xl bg-teal-50 p-3 text-teal-700">
                <Puzzle size={24} />
              </div>
              <button
                type="button"
                autoFocus
                onClick={() => setShowHelp(false)}
                aria-label="关闭安装说明"
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
              >
                <X size={18} />
              </button>
            </div>
            <h2 id="extension-help-title" className="text-lg font-semibold">
              首次使用 ProductSpy
            </h2>
            <FirstUseGuide />
            <BridgePairing />
            <button
              type="button"
              onClick={() => setShowHelp(false)}
              className="mt-5 w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-800"
            >
              明白了
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
