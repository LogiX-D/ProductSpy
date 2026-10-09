'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Images, Loader2 } from 'lucide-react';
import { errorMessage, type Product } from '@productspy/shared';
import { Button, CopyButton, EmptyState, ErrorNotice, ProductImage } from './ui';
import { webFetch } from '../lib/session';
import { workspaceCopy as copy } from './workspace-copy';

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
    let message = copy.media.requestFailed(response.status);
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
  if (!blob.size || !IMAGE_EXTENSIONS[blob.type]) throw new Error(copy.media.invalidImage);
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
  const [percentage, setPercentage] = useState<number>();
  const [failedVideos, setFailedVideos] = useState<string[]>([]);
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
    setProgress(copy.media.preparing);
    setPercentage(job === 'all' ? 0 : undefined);
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
    setProgress(copy.media.imageBusy(index + 1));
    try {
      const blob = await fetchImage(images[index], controller.signal);
      if (controller.signal.aborted) return;
      saveBlob(blob, imageFilename(blob, index));
      setProgress(copy.media.imageSaved(index + 1));
      setPercentage(100);
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
        setProgress(copy.media.zipImageBusy(currentImage, images.length));
        const blob = await fetchImage(images[index], controller.signal);
        if (controller.signal.aborted) return;
        totalBytes += blob.size;
        if (totalBytes > MAX_ZIP_BYTES) throw new Error(copy.media.zipTooLarge);
        zip.file(imageFilename(blob, index), await blob.arrayBuffer());
        setPercentage(Math.round(((index + 1) / images.length) * 85));
      }
      setProgress(copy.media.zipBusy);
      const archive = await zip.generateAsync(
        { type: 'blob', compression: 'STORE' },
        (metadata) => {
          if (controller.signal.aborted) return;
          setProgress(copy.media.zipProgress(Math.round(metadata.percent)));
          setPercentage(Math.round(85 + metadata.percent * 0.15));
        },
      );
      if (controller.signal.aborted) return;
      if (archive.size > MAX_ZIP_BYTES) throw new Error(copy.media.archiveTooLarge);
      saveBlob(archive, `${product.sourceId}-images.zip`);
      setProgress(copy.media.zipSaved(images.length));
      setPercentage(100);
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[ProductSpy media] ZIP download failed', error);
        setFailure({
          message: copy.media.zipFailed(currentImage || 1, errorMessage(error)),
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
    <div className="ws-media">
      <div className="section-header">
        <div>
          <h2>
            {copy.media.images}{' '}
            <span className="small muted">{copy.media.imageCount(images.length)}</span>
          </h2>
          <p className="small muted">{copy.media.imageDescription}</p>
        </div>
        <Button
          aria-label={copy.media.downloadZip}
          variant="secondary"
          disabled={!images.length || busy !== undefined}
          onClick={() => void downloadAll()}
        >
          {busy === 'all' ? <Loader2 size={15} className="spin" /> : <Images size={15} />}
          {busy === 'all' ? copy.media.downloading : copy.media.downloadAll}
        </Button>
      </div>
      {failure && <ErrorNotice message={failure.message} onRetry={retryDownload} />}
      {progress && !failure && (
        <div className="ws-download-progress">
          <p role="status">{progress}</p>
          {busy !== undefined && (
            <>
              <progress max={100} value={percentage} aria-label={copy.media.progress} />
              <Button
                variant="ghost"
                onClick={() => {
                  controllerRef.current?.abort();
                  setProgress(copy.media.downloadCancelled);
                }}
              >
                {copy.media.cancelDownload}
              </Button>
            </>
          )}
        </div>
      )}
      {images.length ? (
        <div className="ws-media-grid">
          {images.map((url, index) => (
            <article className="panel ws-media-card" key={url}>
              <ProductImage src={url} alt={copy.gallery.alt(product.title, index + 1)} />
              <div className="ws-media-card-footer">
                <Button
                  aria-label={copy.media.downloadLabel(index + 1)}
                  variant="ghost"
                  disabled={busy !== undefined}
                  onClick={() => void downloadImage(index)}
                >
                  {busy === index ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                  {busy === index ? copy.media.downloading : copy.media.downloadImage}
                </Button>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={copy.media.originalLabel(index + 1)}
                  title={copy.media.originalTitle}
                  className="ws-text-link"
                >
                  <ExternalLink size={13} />
                  {copy.media.original}
                </a>
                <CopyButton value={url} label={copy.media.copyImage} />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={copy.media.emptyImages}
          description={copy.media.emptyImagesDescription}
        />
      )}
      <section className="ws-media-videos">
        <div className="section-header">
          <div>
            <h2>
              {copy.media.videos}{' '}
              <span className="small muted">{copy.media.videoCount(product.videos.length)}</span>
            </h2>
            <p className="small muted">{copy.media.videoDescription}</p>
          </div>
        </div>
        {product.videos.length ? (
          <div className="ws-media-grid">
            {product.videos.map((video) => (
              <article key={video.url} className="panel ws-video-card">
                <video
                  controls
                  preload="none"
                  poster={video.thumbnail}
                  src={video.url}
                  onError={() =>
                    setFailedVideos((values) =>
                      values.includes(video.url) ? values : [...values, video.url],
                    )
                  }
                />
                {failedVideos.includes(video.url) && (
                  <p role="status" className="ws-video-error">
                    {copy.media.videoFailed}
                  </p>
                )}
                <div className="ws-video-actions">
                  <a href={video.url} target="_blank" rel="noreferrer" className="ws-text-link">
                    <ExternalLink size={14} />
                    {copy.media.openVideo}
                  </a>
                  <CopyButton value={video.url} label={copy.media.copyVideo} />
                </div>
                <p className="small muted">
                  {new URL(video.url).pathname.toLowerCase().endsWith('.m3u8')
                    ? copy.media.hls
                    : copy.media.videoNote}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="ws-empty-videos">{copy.media.emptyVideos}</p>
        )}
      </section>
      <p className="notice">{copy.media.limits}</p>
    </div>
  );
}
