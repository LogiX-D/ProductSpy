'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
  const productPage = pathname.startsWith('/products');
  const navigation = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard, active: !productPage },
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
          Product intelligence
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
            Local first · 本机素材库
          </div>
          <button
            type="button"
            onClick={() => setShowHelp(true)}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm text-slate-300 hover:text-white"
          >
            <Puzzle size={18} />
            安装 Chrome 扩展
            <ArrowUpRight size={15} className="ml-auto" />
          </button>
          <p className="mt-4 px-2 text-[11px] text-slate-500">ProductSpy · MVP 0.1</p>
        </div>
      </aside>
      <div className="md:pl-[218px]">
        <header className="flex h-[65px] items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 sm:px-8">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="font-semibold text-slate-900 md:hidden">ProductSpy</span>
            <span className="hidden md:inline">工作台</span>
            <ChevronRight size={14} />
            <span className="text-slate-800">{productPage ? '商品库' : 'Dashboard'}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-xs text-slate-500 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-500" />
              本地工作空间
            </span>
            <button
              type="button"
              onClick={() => setShowHelp(true)}
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
            role="dialog"
            aria-modal="true"
            aria-labelledby="extension-help-title"
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="mb-4 rounded-xl bg-teal-50 p-3 text-teal-700">
                <Puzzle size={24} />
              </div>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                aria-label="关闭安装说明"
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
              >
                <X size={18} />
              </button>
            </div>
            <h2 id="extension-help-title" className="text-lg font-semibold">
              安装 ProductSpy 扩展
            </h2>
            <ol className="my-5 list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-600">
              <li>
                在项目目录运行{' '}
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">pnpm build</code>。
              </li>
              <li>
                在 Chrome 地址栏输入{' '}
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                  chrome://extensions
                </code>
                ，打开「开发者模式」。
              </li>
              <li>
                点击「加载已解压的扩展程序」，选择{' '}
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                  apps/extension/dist
                </code>
                。
              </li>
              <li>打开 Amazon 商品详情页，点击扩展，再点击「保存到素材库」。</li>
            </ol>
            <p className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">
              保持本地工作台运行。扩展保存成功后，商品库会自动刷新。
            </p>
            <button
              type="button"
              autoFocus
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
