'use client';

import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  ImageOff,
  Loader2,
  PackageSearch,
  RefreshCw,
} from 'lucide-react';
import { uiCopy } from './ui-copy';

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button type={type} className={`button button-${variant} ${className}`} {...props}>
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
          <span>{uiCopy.noImage}</span>
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
          {uiCopy.retry}
        </Button>
      )}
    </div>
  );
}
export function LoadingState() {
  return (
    <div className="loading-state" role="status">
      <Loader2 className="spin" size={24} />
      <span>{uiCopy.loading}</span>
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
export function CopyButton({ value, label = uiCopy.copy }: { value: string; label?: string }) {
  const id = useId();
  const [result, setResult] = useState<{ value: string; state: 'copied' | 'failed' }>();
  const status = result?.value === value ? result.state : undefined;
  const title =
    label === 'Copy' ? uiCopy.copy : label === 'Copy Script' ? uiCopy.copyScript : label;
  useEffect(() => {
    if (result?.state !== 'copied') return;
    const timer = window.setTimeout(() => setResult(undefined), 2200);
    return () => window.clearTimeout(timer);
  }, [result]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setResult({ value, state: 'copied' });
    } catch (reason: unknown) {
      console.warn('[ProductSpy] Clipboard unavailable', reason);
      setResult({ value, state: 'failed' });
    }
  }
  return (
    <div className="copy-control">
      <Button
        variant="ghost"
        onClick={() => void copy()}
        aria-label={`${title} ${value.slice(0, 20)}`}
        aria-describedby={status === 'failed' ? id : undefined}
      >
        {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        {status === 'copied' ? uiCopy.copied : title}
      </Button>
      {status === 'copied' && (
        <span className="sr-only" role="status">
          {uiCopy.copied}
        </span>
      )}
      {status === 'failed' && (
        <div className="copy-fallback" id={id}>
          <p role="status">{uiCopy.copyingFailed}</p>
          <textarea
            readOnly
            rows={3}
            value={value}
            aria-label={uiCopy.manualCopy}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}
