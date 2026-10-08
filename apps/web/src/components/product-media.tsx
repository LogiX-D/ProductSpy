'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Images, Loader2 } from 'lucide-react';
import { errorMessage, type Product } from '@productspy/shared';
import { Button, EmptyState, ErrorNotice, ProductImage } from './ui';
import { webFetch } from '../lib/session';

const MAX_ZIP_BYTES = 80 * 1024 * 1024;
type DownloadJob = number | 'all';
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

async function fetchImage(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await webFetch(`/api/media?url=${encodeURIComponent(url)}`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) {
    let message = `图片下载失败 (${response.status})`;
    try {
      const result: unknown = await response.json();
      if (
        result &&
        typeof result === 'object' &&
        'error' in result &&
        typeof result.error === 'string'
      )
        message = result.error;
    } catch {
      // An interrupted response may not contain the API's JSON error envelope.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  if (!blob.size || !IMAGE_EXTENSIONS[blob.type])
    throw new Error('工作台未返回有效图片，请打开原图后手动保存');
  return blob;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ProductMedia({ product }: { product: Product }) {
  const images = [
    ...new Set(
      [product.mainImage, ...product.images].filter((value): value is string => Boolean(value)),
    ),
  ];
  const [busy, setBusy] = useState<DownloadJob>();
  const [progress, setProgress] = useState('');
  const [failure, setFailure] = useState<{ message: string; job: DownloadJob }>();
  const controllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = undefined;
    };
  }, []);

  function beginDownload(job: DownloadJob): AbortController | undefined {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(job);
    setFailure(undefined);
    setProgress('');
    return controller;
  }

  function finishDownload(controller: AbortController): void {
    if (controllerRef.current === controller) {
      controllerRef.current = undefined;
      setBusy(undefined);
    }
  }

  function imageFilename(blob: Blob, index: number): string {
    return `${product.sourceId}-${String(index + 1).padStart(2, '0')}.${IMAGE_EXTENSIONS[blob.type]}`;
  }

  async function downloadImage(index: number): Promise<void> {
    const controller = beginDownload(index);
    if (!controller) return;
    try {
      const blob = await fetchImage(images[index], controller.signal);
      if (controller.signal.aborted) return;
      saveBlob(blob, imageFilename(blob, index));
      setProgress(`图片 ${index + 1} 已下载`);
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[ProductSpy media] Single image download failed', error);
        setFailure({ message: errorMessage(error), job: index });
      }
    } finally {
      finishDownload(controller);
    }
  }

  async function downloadAll(): Promise<void> {
    const controller = beginDownload('all');
    if (!controller) return;
    let currentImage = 0;
    try {
      const { default: JSZip } = await import('jszip');
      if (controller.signal.aborted) return;
      const zip = new JSZip();
      let totalBytes = 0;
      for (let index = 0; index < images.length; index++) {
        currentImage = index + 1;
        setProgress(`正在下载图片 ${currentImage} / ${images.length}`);
        const blob = await fetchImage(images[index], controller.signal);
        if (controller.signal.aborted) return;
        totalBytes += blob.size;
        if (totalBytes > MAX_ZIP_BYTES) throw new Error('全部图片超过 80 MiB ZIP 限制，请逐张下载');
        zip.file(imageFilename(blob, index), await blob.arrayBuffer());
      }
      setProgress('正在生成 ZIP…');
      const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      if (controller.signal.aborted) return;
      if (archive.size > MAX_ZIP_BYTES) throw new Error('ZIP 文件超过 80 MiB 限制，请逐张下载');
      saveBlob(archive, `${product.sourceId}-images.zip`);
      setProgress(`已下载 ${images.length} 张图片（ZIP）`);
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[ProductSpy media] ZIP download failed', error);
        setFailure({
          message: `图片 ${currentImage || 1} 处理失败：${errorMessage(error)}。尚未生成 ZIP，请重试或打开原图逐张保存。`,
          job: 'all',
        });
      }
    } finally {
      finishDownload(controller);
    }
  }

  const retryDownload = () => {
    if (!failure) return;
    if (failure.job === 'all') void downloadAll();
    else void downloadImage(failure.job);
  };

  return (
    <div>
      <div className="section-header">
        <div>
          <h2>
            商品图片 <span className="small muted">· {images.length} 张</span>
          </h2>
          <p className="small muted mt-1">保存公开图片 URL，按需下载素材。</p>
        </div>
        <Button
          variant="secondary"
          disabled={!images.length || busy !== undefined}
          onClick={() => void downloadAll()}
        >
          {busy === 'all' ? <Loader2 size={15} className="spin" /> : <Images size={15} />}Download
          All Images
        </Button>
      </div>
      {failure && <ErrorNotice message={failure.message} onRetry={retryDownload} />}
      {progress && !failure && (
        <p role="status" className="small muted mb-4">
          {progress}
        </p>
      )}
      {images.length ? (
        <div className="media-grid">
          {images.map((url, index) => (
            <article className="panel media-card" key={url}>
              <ProductImage src={url} alt={`${product.title} 图片 ${index + 1}`} />
              <div className="media-card-footer">
                <Button
                  variant="ghost"
                  disabled={busy !== undefined}
                  onClick={() => void downloadImage(index)}
                >
                  {busy === index ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                  Download Image
                </Button>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`打开原图 ${index + 1}`}
                  title="打开原图后手动保存"
                  className="flex items-center gap-1 text-xs text-teal-700 hover:underline"
                >
                  <ExternalLink size={13} />
                  原图
                </a>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="此商品没有可用图片"
          description="Amazon 页面可能尚未加载图片。请重新打开商品页面并再次采集。"
        />
      )}
      <section className="mt-8">
        <div className="section-header">
          <div>
            <h2>
              商品视频 <span className="small muted">· {product.videos.length} 个</span>
            </h2>
            <p className="small muted mt-1">仅展示商品页面已公开提供的视频，不绕过访问限制。</p>
          </div>
        </div>
        {product.videos.length ? (
          <div className="media-grid">
            {product.videos.map((video) => (
              <article key={video.url} className="panel video-card">
                <video controls preload="none" poster={video.thumbnail} src={video.url} />
                <a
                  href={video.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-teal-700 hover:underline"
                >
                  <ExternalLink size={14} />
                  打开视频原始链接
                </a>
                <p className="small muted mt-2">
                  {new URL(video.url).pathname.toLowerCase().endsWith('.m3u8')
                    ? '这是 HLS 视频流，部分浏览器无法直接播放。请使用原始链接。'
                    : '视频链接可能过期或受跨域限制。播放失败时可尝试原始链接。'}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-200 bg-white p-6 text-sm text-slate-500">
            此页面没有可可靠提取的公开视频。
          </p>
        )}
      </section>
      <p className="notice">
        单张图片限制 10 MiB，ZIP 限制 80 MiB。部分素材可能受 Amazon CDN
        访问限制；下载失败时可打开原图手动保存。
      </p>
    </div>
  );
}
