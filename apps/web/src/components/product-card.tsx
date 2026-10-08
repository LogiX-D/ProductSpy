'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ImageIcon, Trash2 } from 'lucide-react';
import type { Product } from '@productspy/shared';
import { Badge, Button, ProductImage } from './ui';
import { formatDate, formatPrice } from '@/lib/format';

interface ProductCardProps {
  product: Product;
  layout?: 'grid' | 'list';
  onDelete?: (id: string) => Promise<boolean>;
  deleting?: boolean;
  deleteDisabled?: boolean;
}

export function ProductCard({
  product,
  layout = 'grid',
  onDelete,
  deleting,
  deleteDisabled,
}: ProductCardProps) {
  const [confirming, setConfirming] = useState(false);
  const href = `/products/${encodeURIComponent(product.id)}`;
  const list = layout === 'list';
  const deleteProduct = async () => {
    if (onDelete && (await onDelete(product.id))) setConfirming(false);
  };

  return (
    <article
      className={`group overflow-hidden rounded-xl border border-slate-200 bg-white transition-shadow hover:shadow-md ${list ? 'flex flex-wrap items-center gap-4 p-4' : ''}`}
    >
      <Link
        href={href}
        tabIndex={-1}
        aria-hidden="true"
        className={
          list
            ? 'h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-slate-50'
            : 'relative block aspect-[4/3] border-b border-slate-100 bg-white p-5'
        }
      >
        <ProductImage
          src={product.mainImage ?? product.images[0]}
          alt={product.title}
          className="h-full w-full object-contain"
        />
        {!list && (
          <span className="absolute bottom-3 left-3 flex items-center gap-1 rounded-md border border-slate-100 bg-white/95 px-2 py-1 text-[10px] text-slate-500">
            <ImageIcon size={12} />
            {product.images.length} 张图片
          </span>
        )}
      </Link>
      <div className={list ? 'min-w-0 flex-1 basis-40' : 'p-4'}>
        <div className="mb-2 flex items-center gap-2">
          <Badge>Amazon</Badge>
          <Badge tone={product.aiAnalysis ? 'success' : 'warning'}>
            {product.aiAnalysis ? '已分析' : '待分析'}
          </Badge>
        </div>
        <Link
          href={href}
          className={`block text-sm font-semibold leading-6 text-slate-800 hover:text-teal-700 ${list ? 'line-clamp-2' : 'line-clamp-2 min-h-12'}`}
        >
          {product.title}
        </Link>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-lg font-semibold tracking-tight text-slate-900">
            {formatPrice(product)}
          </span>
          {product.brand && (
            <span className="max-w-28 truncate text-xs text-slate-400">{product.brand}</span>
          )}
        </div>
        <p className="mt-2 font-mono text-[11px] text-slate-400">ASIN · {product.sourceId}</p>
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <span className="text-[11px] text-slate-400">采集于 {formatDate(product.createdAt)}</span>
          <div className="flex items-center gap-1">
            <Link
              href={href}
              aria-label={`打开商品 ${product.title}`}
              className="rounded-md p-1.5 text-slate-400 hover:bg-teal-50 hover:text-teal-700"
            >
              <ArrowUpRight size={16} />
            </Link>
            {onDelete && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={deleteDisabled}
                aria-label={`删除商品 ${product.title}`}
                className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      {confirming && (
        <div className={`border-t border-red-100 bg-red-50/60 px-4 py-3 ${list ? 'w-full' : ''}`}>
          <p className="mb-2 text-xs leading-5 text-red-700">
            删除此商品及 AI 分析？此操作无法撤销。
          </p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              disabled={deleteDisabled}
              onClick={() => void deleteProduct()}
              className="!px-3 !py-1.5 !text-xs"
            >
              {deleting ? '正在删除…' : '确认删除'}
            </Button>
            <Button
              variant="ghost"
              disabled={deleting}
              onClick={() => setConfirming(false)}
              className="!px-3 !py-1.5 !text-xs"
            >
              取消
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
