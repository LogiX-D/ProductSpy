'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ImageIcon, Trash2 } from 'lucide-react';
import type { Product } from '@productspy/shared';
import { Badge, Button, ProductImage } from './ui';
import { formatDate, formatPrice } from '@/lib/format';
import { workspaceCopy as copy } from './workspace-copy';

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
  const [deleteFailed, setDeleteFailed] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const href = `/products/${encodeURIComponent(product.id)}`;
  const list = layout === 'list';
  const imageCount = new Set([product.mainImage, ...product.images].filter(Boolean)).size;
  async function deleteProduct() {
    if (!onDelete) return;
    try {
      if (await onDelete(product.id)) setConfirming(false);
      else setDeleteFailed(true);
    } catch {
      setDeleteFailed(true);
    }
  }
  function cancelDelete() {
    setConfirming(false);
    setDeleteFailed(false);
    deleteTrigger.current?.focus();
  }
  return (
    <article className={`ws-product-card${list ? ' ws-product-card-list' : ''}`}>
      <Link href={href} tabIndex={-1} aria-hidden="true" className="ws-card-image">
        <ProductImage src={product.mainImage ?? product.images[0]} alt={product.title} />
        {!list && (
          <span className="ws-card-image-count">
            <ImageIcon size={12} />
            {copy.card.images(imageCount)}
          </span>
        )}
      </Link>
      <div className="ws-card-content">
        <div className="ws-card-badges">
          <Badge>{copy.common.amazon}</Badge>
          <Badge tone={product.aiAnalysis ? 'success' : 'warning'}>
            {product.aiAnalysis ? copy.common.analyzed : copy.common.pending}
          </Badge>
        </div>
        <Link href={href} className="ws-card-title">
          {product.title}
        </Link>
        <div className="ws-card-price-line">
          <span className="ws-card-price">{formatPrice(product)}</span>
          {product.brand && (
            <span className="ws-card-brand" title={product.brand}>
              {product.brand}
            </span>
          )}
        </div>
        <p className="ws-card-asin">ASIN · {product.sourceId}</p>
        <div className="ws-card-footer">
          <span>{copy.card.collected(formatDate(product.createdAt))}</span>
          <div className="ws-card-actions">
            <Link href={href} aria-label={copy.card.open(product.title)} className="ws-icon-button">
              <ArrowUpRight size={16} />
            </Link>
            {onDelete && (
              <button
                ref={deleteTrigger}
                type="button"
                disabled={deleteDisabled}
                aria-label={copy.card.delete(product.title)}
                className="ws-icon-button ws-delete-button"
                onClick={() => {
                  setConfirming(true);
                  setDeleteFailed(false);
                }}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      {confirming && (
        <div
          className="ws-confirm-delete"
          role="group"
          aria-label={copy.card.confirmTitle}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !deleting) {
              event.preventDefault();
              cancelDelete();
            }
          }}
        >
          <strong>{copy.card.confirmTitle}</strong>
          <p className="ws-delete-product-title">{product.title}</p>
          <p>{copy.card.confirmDescription}</p>
          {deleteFailed && <p role="alert">{copy.card.failed}</p>}
          <div className="ws-inline">
            <Button variant="danger" disabled={deleteDisabled} onClick={() => void deleteProduct()}>
              {deleting ? copy.card.deleting : copy.card.confirm}
            </Button>
            <Button autoFocus variant="ghost" disabled={deleting} onClick={cancelDelete}>
              {copy.common.cancel}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
