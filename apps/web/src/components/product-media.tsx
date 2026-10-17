'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, FolderOpen, Images } from 'lucide-react';
import {
  buildProductMediaAssets,
  identifyMedia,
  errorMessage,
  safeMediaFilename,
  type MediaAsset,
  type MediaDownloadEntry,
  type MediaDownloadJob,
  type Product,
} from '@productspy/shared';
import { Button, CopyButton, EmptyState, ErrorNotice } from './ui';
import { isLegacyMode, webFetch, webRequest } from '../lib/session';
import { workspaceCopy as copy } from './workspace-copy';
import './media.css';

const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
interface SaveHandle {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
}
interface PickerWindow extends Window {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveHandle>;
}

async function fetchAsset(asset: MediaAsset, url: string, signal: AbortSignal): Promise<Blob> {
  const response = await webFetch(`/api/media?url=${encodeURIComponent(url)}&kind=${asset.kind}`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) {
    let message = `素材下载失败 (${response.status})`;
    try {
      const data: unknown = await response.json();
      if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string')
        message = data.error;
    } catch {
      /* Interrupted responses may have no JSON envelope. */
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  if (!blob.size || !EXTENSIONS[blob.type]) throw new Error('工作台没有返回有效的素材文件');
  return blob;
}
function saveBrowserBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function blobHash(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function isCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function ProductMedia({ product }: { product: Product }) {
  const assets = useMemo(() => buildProductMediaAssets(product), [product]);
  const images = assets.filter((item) => item.kind === 'image');
  const videos = assets.filter((item) => item.kind === 'video');
  const [selected, setSelected] = useState<string[]>([]);
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>(
    {},
  );
  const [job, setJob] = useState<MediaDownloadJob>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [percentage, setPercentage] = useState(0);
  const [failure, setFailure] = useState<string>();
  const [retryIds, setRetryIds] = useState<string[]>([]);
  const [failedVideos, setFailedVideos] = useState<string[]>([]);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const [browserPromptConfirmed, setBrowserPromptConfirmed] = useState(false);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [hasSavePicker, setHasSavePicker] = useState(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const choosingRef = useRef(false);
  const mountedRef = useRef(true);
  const jobRef = useRef<MediaDownloadJob | undefined>(undefined);
  jobRef.current = job;
  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    setHasSavePicker(Boolean((window as PickerWindow).showSaveFilePicker));
    if (isLegacyMode)
      void webRequest<{ nativeDirectoryPicker: boolean }>('/api/media/downloads')
        .then((data) => {
          if (active) setNativeAvailable(data.nativeDirectoryPicker);
        })
        .catch(() => undefined);
    return () => {
      active = false;
      mountedRef.current = false;
      controllerRef.current?.abort();
      if (choosingRef.current)
        void webRequest('/api/media/downloads', {
          method: 'POST',
          body: JSON.stringify({ action: 'cancel-picker' }),
        }).catch(() => undefined);
      if (jobRef.current)
        void webRequest('/api/media/downloads', {
          method: 'POST',
          body: JSON.stringify({ action: 'cancel', jobId: jobRef.current.id }),
        }).catch(() => undefined);
    };
  }, []);
  const currentUrl = (asset: MediaAsset) => variants[asset.id] ?? asset.url;
  const sourceEntry = (
    asset: MediaAsset,
    status: MediaDownloadEntry['status'],
    extra: Partial<MediaDownloadEntry> = {},
  ): MediaDownloadEntry => ({
    assetId: asset.id,
    kind: asset.kind,
    sourceUrl: currentUrl(asset),
    sourcePage: asset.sourceUrl,
    productId: product.id,
    asin: product.sourceId,
    extractedAt: asset.extractedAt,
    extractionTimeKnown: asset.extractionTimeKnown,
    status,
    ...extra,
  });

  async function chooseDirectory(): Promise<void> {
    if (busy) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    choosingRef.current = true;
    setBusy(true);
    setFailure(undefined);
    setProgress('请在 Windows 窗口中选择素材保存目录…');
    try {
      const result = await webRequest<{ job: MediaDownloadJob | null }>('/api/media/downloads', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ action: 'prepare', productId: product.id }),
      });
      if (controller.signal.aborted || !mountedRef.current) {
        if (result.job)
          void webRequest('/api/media/downloads', {
            method: 'POST',
            body: JSON.stringify({ action: 'cancel', jobId: result.job.id }),
          }).catch(() => undefined);
        return;
      }
      if (result.job) {
        setJob(result.job);
        setProgress('保存目录已选择。勾选素材后开始下载。');
      } else setProgress('已取消目录选择，没有写入任何文件。');
    } catch (error) {
      if (!controller.signal.aborted && mountedRef.current) setFailure(errorMessage(error));
    } finally {
      choosingRef.current = false;
      controllerRef.current = undefined;
      if (mountedRef.current) {
        setBusy(false);
        if (controller.signal.aborted) setProgress('已取消目录选择，没有写入任何文件。');
      }
    }
  }
  async function downloadToDirectory(ids: string[]): Promise<void> {
    if (busy || !job) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setFailure(undefined);
    setRetryIds([]);
    setPercentage(0);
    let latest = job;
    const failures: string[] = [];
    try {
      for (let index = 0; index < ids.length; index++) {
        if (controller.signal.aborted) break;
        const asset = assets.find((item) => item.id === ids[index]);
        if (!asset) continue;
        setProgress(`正在保存素材 ${index + 1} / ${ids.length}…`);
        const result = await webRequest<{ job: MediaDownloadJob }>('/api/media/downloads', {
          method: 'POST',
          body: JSON.stringify({
            action: 'download',
            jobId: latest.id,
            assetId: asset.id,
            url: currentUrl(asset),
          }),
        });
        latest = result.job;
        setJob(latest);
        const entry = latest.entries.find(
          (item) => item.assetId === asset.id && item.sourceUrl === currentUrl(asset),
        );
        if (!entry || ['failed', 'cancelled'].includes(entry.status)) failures.push(asset.id);
        setPercentage(Math.round(((index + 1) / ids.length) * 100));
      }
      const successes = latest.entries.filter((item) => item.status === 'saved').length;
      const duplicates = latest.entries.filter((item) => item.status === 'duplicate').length;
      setProgress(
        `${controller.signal.aborted ? '已取消。' : '下载完成。'}成功 ${successes}，重复 ${duplicates}，失败 ${failures.length}。已保存的文件保持不变。`,
      );
      setRetryIds(failures);
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(errorMessage(error));
        setRetryIds(
          ids.filter(
            (id) =>
              !latest.entries.some(
                (entry) => entry.assetId === id && ['saved', 'duplicate'].includes(entry.status),
              ),
          ),
        );
      }
    } finally {
      controllerRef.current = undefined;
      setBusy(false);
    }
  }
  async function cancelDownload(): Promise<void> {
    controllerRef.current?.abort();
    setProgress('正在取消…已完成的文件会保留。');
    if (choosingRef.current) {
      await webRequest('/api/media/downloads', {
        method: 'POST',
        body: JSON.stringify({ action: 'cancel-picker' }),
      }).catch((error: unknown) => setFailure(errorMessage(error)));
      return;
    }
    if (job) {
      try {
        const result = await webRequest<{ job: MediaDownloadJob }>('/api/media/downloads', {
          method: 'POST',
          body: JSON.stringify({ action: 'cancel', jobId: job.id }),
        });
        setJob(result.job);
      } catch (error) {
        setFailure(errorMessage(error));
      }
    }
  }
  async function openLocation(assetId?: string): Promise<void> {
    if (!job) return;
    try {
      await webRequest('/api/media/downloads', {
        method: 'POST',
        body: JSON.stringify({ action: 'open', jobId: job.id, ...(assetId ? { assetId } : {}) }),
      });
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }
  async function browserSave(ids: string[], zip: boolean): Promise<void> {
    if (busy) return;
    const picker = (window as PickerWindow).showSaveFilePicker;
    if (!picker && !browserPromptConfirmed) {
      setFailure(
        '此浏览器不支持文件选择 API。请先开启“下载前询问每个文件的保存位置”，并勾选下方确认。',
      );
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setFailure(undefined);
    setProgress('请选择保存位置…');
    setPercentage(0);
    let writer: Awaited<ReturnType<SaveHandle['createWritable']>> | undefined;
    try {
      const first = assets.find((item) => item.id === ids[0]);
      if (!first) return;
      const suggested = zip
        ? `${safeMediaFilename(product.title, product.sourceId, 'image', 1, 'zip').replace('-01.zip', '-素材.zip')}`
        : safeMediaFilename(
            product.title,
            product.sourceId,
            first.kind,
            Number(first.id.split('-')[1]),
            first.kind === 'video' ? first.format : 'jpg',
          );
      // Invoke the picker before any fetch so browsers retain the user's activation.
      const handle = picker ? await picker.call(window, { suggestedName: suggested }) : undefined;
      const manifest: MediaDownloadEntry[] = [];
      const hashes = new Map<string, string>();
      let totalBytes = 0;
      const JSZip = zip ? (await import('jszip')).default : undefined;
      const archive = JSZip ? new JSZip() : undefined;
      let singleBlob: Blob | undefined;
      let finalFilename = suggested;
      for (let index = 0; index < ids.length; index++) {
        if (controller.signal.aborted) return;
        const asset = assets.find((item) => item.id === ids[index]);
        if (!asset) continue;
        setProgress(`正在下载素材 ${index + 1} / ${ids.length}…`);
        try {
          const blob = await fetchAsset(asset, currentUrl(asset), controller.signal);
          totalBytes += blob.size;
          if (totalBytes > MAX_ZIP_BYTES) throw new Error('素材超过 80 MiB ZIP 限制，请分批下载');
          const sha256 = await blobHash(blob);
          const filename = safeMediaFilename(
            product.title,
            product.sourceId,
            asset.kind,
            Number(asset.id.split('-')[1]),
            EXTENSIONS[blob.type],
          );
          const previous = hashes.get(sha256);
          manifest.push(
            sourceEntry(asset, previous ? 'duplicate' : 'saved', {
              sha256,
              filename: previous ?? filename,
              bytes: blob.size,
              contentType: blob.type,
            }),
          );
          if (!previous) {
            hashes.set(sha256, filename);
            if (archive) archive.file(filename, await blob.arrayBuffer());
            else {
              singleBlob = blob;
              finalFilename = filename;
            }
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          manifest.push(sourceEntry(asset, 'failed', { error: errorMessage(error) }));
        }
        setPercentage(Math.round(((index + 1) / ids.length) * 85));
      }
      const success = manifest.filter((entry) => entry.status === 'saved').length;
      const failures = manifest.filter((entry) => entry.status === 'failed');
      if (!success) throw new Error(failures[0]?.error ?? '没有成功下载的素材');
      let blob = singleBlob;
      if (archive) {
        archive.file(
          '素材来源.json',
          JSON.stringify(
            {
              schemaVersion: 1,
              productId: product.id,
              asin: product.sourceId,
              title: product.title,
              entries: manifest,
            },
            null,
            2,
          ),
        );
        setProgress('正在生成素材 ZIP…');
        blob = await archive.generateAsync({ type: 'blob', compression: 'STORE' }, (metadata) =>
          setPercentage(85 + Math.round(metadata.percent * 0.15)),
        );
      }
      if (controller.signal.aborted || !blob) return;
      if (handle) {
        writer = await handle.createWritable();
        await writer.write(blob);
        await writer.close();
        writer = undefined;
      } else saveBrowserBlob(blob, finalFilename);
      setPercentage(100);
      setProgress(
        `已保存：成功 ${success}，重复 ${manifest.filter((entry) => entry.status === 'duplicate').length}，失败 ${failures.length}。${archive ? 'ZIP 内附素材来源清单。' : ''}`,
      );
      if (failures.length)
        setFailure(failures.map((entry) => `${entry.assetId}：${entry.error}`).join('；'));
      setRetryIds(failures.map((entry) => entry.assetId));
    } catch (error) {
      if (!controller.signal.aborted && !isCancelled(error)) setFailure(errorMessage(error));
      else setProgress('已取消保存，没有生成新的下载文件。');
    } finally {
      await writer?.abort().catch(() => undefined);
      if (controller.signal.aborted) setProgress('已取消保存，没有生成新的下载文件。');
      controllerRef.current = undefined;
      setBusy(false);
    }
  }
  const downloadOne = (asset: MediaAsset) =>
    job ? downloadToDirectory([asset.id]) : browserSave([asset.id], false);

  return (
    <div className="ws-media">
      <div className="section-header">
        <div>
          <h2>商品素材</h2>
          <p className="small muted">
            素材来自商品页面采集；链接可能失效。原始资料不会因下载修改。
          </p>
        </div>
      </div>
      <div className="media-destination panel">
        <div>
          <strong>保存位置</strong>
          <p className="small muted">{job ? job.directory : '素材由浏览器下载到你选择的位置。'}</p>
        </div>
        <div className="media-actions">
          {nativeAvailable && (
            <Button variant="secondary" disabled={busy} onClick={() => void chooseDirectory()}>
              <FolderOpen size={15} /> {job ? '更换保存目录' : '选择保存目录'}
            </Button>
          )}
          {job && (
            <Button variant="ghost" onClick={() => void openLocation()}>
              打开保存目录
            </Button>
          )}
        </div>
        {!hasSavePicker && (
          <label className="media-browser-confirm">
            <input
              type="checkbox"
              checked={browserPromptConfirmed}
              onChange={(event) => setBrowserPromptConfirmed(event.target.checked)}
            />
            我的浏览器已开启“下载前询问每个文件的保存位置”（浏览器另存为必需）
          </label>
        )}
        <p className="small muted">
          {isLegacyMode
            ? 'Windows 目录下载会保留来源清单和 SHA-256；不会覆盖已有文件。保存会话 30 分钟内有效。'
            : '浏览器 ZIP 下载包含来源清单与 SHA-256。素材下载至当前设备，不会写入云服务器的本地目录。'}
        </p>
      </div>
      {failure && <ErrorNotice message={failure} />}
      {progress && (
        <div className="ws-download-progress">
          <p role="status">{progress}</p>
          {busy && (
            <>
              <progress max={100} value={percentage} aria-label={copy.media.progress} />
              <Button variant="ghost" onClick={() => void cancelDownload()}>
                取消下载
              </Button>
            </>
          )}
          {retryIds.length > 0 && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void (job ? downloadToDirectory(retryIds) : browserSave(retryIds, true))
              }
            >
              仅重试失败素材（{retryIds.length}）
            </Button>
          )}
        </div>
      )}
      {job && job.entries.length > 0 && (
        <ul className="media-results" aria-label="素材保存结果">
          {job.entries.map((entry) => (
            <li key={`${entry.assetId}-${entry.sourceUrl}`}>
              <span>
                {entry.assetId} ·{' '}
                {entry.status === 'saved'
                  ? '已保存'
                  : entry.status === 'duplicate'
                    ? '内容重复，已复用文件'
                    : entry.status === 'cancelled'
                      ? '已取消'
                      : '失败'}{' '}
                {entry.error ?? ''}
              </span>
              {entry.filename && ['saved', 'duplicate'].includes(entry.status) && (
                <Button variant="ghost" onClick={() => void openLocation(entry.assetId)}>
                  打开文件位置
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="section-header">
        <div>
          <h2>
            {copy.media.images} <span className="small muted">· {images.length} 张</span>
          </h2>
          <p className="small muted">
            已按 URL 合并重复素材。只使用实际采集的来源，尺寸未知时不会宣称高清。
          </p>
        </div>
        <div className="media-actions">
          <Button
            aria-label="下载全部图片（ZIP）"
            variant="secondary"
            disabled={busy || !images.length}
            onClick={() =>
              void browserSave(
                images.map((asset) => asset.id),
                true,
              )
            }
          >
            <Images size={15} />
            另存全部图片 ZIP
          </Button>
        </div>
      </div>
      {images.length > 0 && (
        <div className="media-selection">
          <label>
            <input
              type="checkbox"
              aria-label="全选图片"
              checked={images.every((asset) => selected.includes(asset.id))}
              onChange={(event) =>
                setSelected(event.target.checked ? images.map((asset) => asset.id) : [])
              }
            />
            全选图片
          </label>
          <span className="small muted">已选 {selected.length}</span>
          <Button
            variant="secondary"
            disabled={busy || !selected.length || !job}
            onClick={() => void downloadToDirectory(selected)}
          >
            下载选中到目录
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !selected.length}
            onClick={() => void browserSave(selected, true)}
          >
            选中图片另存 ZIP
          </Button>
        </div>
      )}
      {images.length ? (
        <div className="ws-media-grid">
          {images.map((asset, index) => {
            const url = currentUrl(asset);
            const known = asset.variants.find((variant) => variant.url === url);
            const size = known?.width && known.height ? known : dimensions[url];
            return (
              <article className="panel ws-media-card" key={asset.id}>
                <label className="media-select-image">
                  <input
                    type="checkbox"
                    checked={selected.includes(asset.id)}
                    aria-label={`选择图片 ${index + 1}`}
                    onChange={(event) =>
                      setSelected((values) =>
                        event.target.checked
                          ? [...values, asset.id]
                          : values.filter((id) => id !== asset.id),
                      )
                    }
                  />
                  图片 {index + 1}
                </label>
                <div className="product-image">
                  {failedImages.includes(url) ? (
                    <div className="media-image-error">
                      <span>图片暂时无法加载</span>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setFailedImages((values) => values.filter((value) => value !== url))
                        }
                      >
                        重新加载预览
                      </Button>
                    </div>
                  ) : (
                    <img
                      src={url}
                      alt={copy.gallery.alt(product.title, index + 1)}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setFailedImages((values) =>
                          values.includes(url) ? values : [...values, url],
                        )
                      }
                      onLoad={(event) => {
                        const size = {
                          width: event.currentTarget.naturalWidth,
                          height: event.currentTarget.naturalHeight,
                        };
                        setDimensions((values) => ({ ...values, [url]: size }));
                      }}
                    />
                  )}
                </div>
                <div className="media-quality">
                  <span>
                    {size
                      ? `${size.width} × ${size.height} px${Math.max(size.width ?? 0, size.height ?? 0) >= 1000 ? ' · 高清尺寸' : ''}`
                      : '尺寸未知'}
                  </span>
                  {asset.variants.length > 1 && (
                    <label>
                      采集来源
                      <select
                        aria-label={`图片 ${index + 1} 来源`}
                        value={url}
                        onChange={(event) =>
                          setVariants((values) => ({ ...values, [asset.id]: event.target.value }))
                        }
                      >
                        {asset.variants.map((variant, variantIndex) => (
                          <option key={variant.url} value={variant.url}>
                            {variant.width && variant.height
                              ? `${variant.width} × ${variant.height}`
                              : `来源 ${variantIndex + 1}（尺寸未知）`}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <small>
                    {asset.extractionTimeKnown ? '提取于' : '旧记录更新时间（提取时间未知）'}{' '}
                    {new Date(asset.extractedAt).toLocaleString('zh-CN')}
                  </small>
                </div>
                <div className="ws-media-card-footer">
                  <Button
                    aria-label={copy.media.downloadLabel(index + 1)}
                    variant="ghost"
                    disabled={busy || !identifyMedia(url, 'image').downloadable}
                    onClick={() => void downloadOne(asset)}
                  >
                    <Download size={14} />
                    {copy.media.downloadImage}
                  </Button>
                  <a href={url} target="_blank" rel="noreferrer" className="ws-text-link">
                    <ExternalLink size={13} />
                    原始链接
                  </a>
                  <CopyButton value={url} label={copy.media.copyImage} />
                </div>
              </article>
            );
          })}
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
              {copy.media.videos} <span className="small muted">· {videos.length} 个</span>
            </h2>
            <p className="small muted">
              仅下载公开 MP4 / WebM 文件，不转换 HLS，也不绕过任何访问限制。
            </p>
          </div>
        </div>
        {videos.length ? (
          <div className="ws-media-grid">
            {videos.map((asset) => (
              <article key={asset.id} className="panel ws-video-card">
                {['mp4', 'webm'].includes(asset.format) ? (
                  <video
                    controls
                    preload="none"
                    poster={asset.thumbnail}
                    src={asset.url}
                    onError={() =>
                      setFailedVideos((values) =>
                        values.includes(asset.id) ? values : [...values, asset.id],
                      )
                    }
                  />
                ) : (
                  <div className="media-video-placeholder">
                    {asset.format === 'hls'
                      ? 'HLS 视频流 · 不支持直接下载'
                      : '未知视频格式 · 仅提供原始链接'}
                  </div>
                )}
                <p className="small muted">
                  格式：{asset.format.toUpperCase()} ·{' '}
                  {asset.downloadable && !failedVideos.includes(asset.id)
                    ? '公开文件，可尝试下载'
                    : '不支持直接下载或链接暂不可用'}
                </p>
                {failedVideos.includes(asset.id) && (
                  <p role="status" className="ws-video-error">
                    视频失效或无法播放，请打开原始链接确认访问状态。
                  </p>
                )}
                <div className="ws-video-actions">
                  {asset.downloadable && !failedVideos.includes(asset.id) && (
                    <Button variant="ghost" disabled={busy} onClick={() => void downloadOne(asset)}>
                      <Download size={14} />
                      下载视频
                    </Button>
                  )}
                  <a href={asset.url} target="_blank" rel="noreferrer" className="ws-text-link">
                    <ExternalLink size={14} />
                    打开视频原始链接
                  </a>
                  <CopyButton value={asset.url} label={copy.media.copyVideo} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="ws-empty-videos">{copy.media.emptyVideos}</p>
        )}
      </section>
      <p className="notice">
        图片限制 10 MiB，直接视频限制 64 MiB，ZIP 限制 80
        MiB。部分链接会过期；失败后可安全重试。内容哈希只在下载后确定，不代表页面中未下载的素材已完成内容去重。
      </p>
    </div>
  );
}
