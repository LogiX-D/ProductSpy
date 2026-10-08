'use client';

import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, ImageOff, Loader2, PackageSearch, RefreshCw } from 'lucide-react';

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button className={`button button-${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'success' | 'warning';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function ProductImage({
  src,
  alt,
  className = '',
}: {
  src?: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState<string>();
  return (
    <div className={`product-image ${className}`}>
      {src && failed !== src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
        />
      ) : (
        <div className="image-placeholder">
          <ImageOff size={28} />
          <span>暂无图片</span>
        </div>
      )}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <PackageSearch size={30} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {onRetry && (
        <Button variant="ghost" onClick={onRetry}>
          <RefreshCw size={14} />
          重试
        </Button>
      )}
    </div>
  );
}
export function LoadingState() {
  return (
    <div className="loading-state" role="status">
      <Loader2 className="spin" size={24} />
      <span>正在加载素材库…</span>
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [status, setStatus] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('已复制');
    } catch {
      setStatus('复制失败，请手动选择文本');
    }
  }
  return (
    <div className="copy-control">
      <Button
        variant="ghost"
        onClick={() => void copy()}
        aria-label={`${label} ${value.slice(0, 20)}`}
      >
        {status === '已复制' ? '已复制' : label}
        <ArrowRight size={13} />
      </Button>
      {status && status !== '已复制' && (
        <span role="status" className="small muted">
          {status}
        </span>
      )}
    </div>
  );
}
