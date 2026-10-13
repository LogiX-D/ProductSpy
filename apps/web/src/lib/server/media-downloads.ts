import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  buildProductMediaAssets,
  safeMediaFilename,
  type MediaAsset,
  type MediaDownloadEntry,
  type MediaDownloadJob,
  type Product,
} from '@productspy/shared';
import { fetchAmazonImage, fetchAmazonVideo, type DownloadedImage } from './media';
import { AppError } from './errors';
import { dataDirectory } from './product-repository';

const run = promisify(execFile);
const JOB_LIFETIME = 30 * 60 * 1000;
const MAX_JOB_BYTES = 300 * 1024 * 1024;
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
interface JobState {
  job: MediaDownloadJob;
  product: Product;
  assets: MediaAsset[];
  directory: string;
  controller: AbortController;
  running: boolean;
  bytes: number;
  dataRoot: string;
  manifestHash?: string;
}
interface NativeOperations {
  chooseDirectory(signal?: AbortSignal): Promise<string | undefined>;
  openLocation(path: string, file: boolean): Promise<void>;
  retrieve(asset: MediaAsset, url: string, signal: AbortSignal): Promise<DownloadedImage>;
}
const pickerScript = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 ProductSpy 素材保存目录（不会覆盖已有文件）'
$dialog.ShowNewFolderButton = $true
try {
 if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  ConvertTo-Json -Compress @{ directory = $dialog.SelectedPath }
 } else { ConvertTo-Json -Compress @{ directory = $null } }
} finally { $dialog.Dispose(); $owner.Dispose() }`;

const nativeOperations: NativeOperations = {
  async chooseDirectory(signal) {
    if (process.platform !== 'win32')
      throw new AppError(501, '本机目录选择目前仅支持 Windows；请使用 ZIP 另存为');
    try {
      const result = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-EncodedCommand',
          Buffer.from(pickerScript, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, timeout: 120000, maxBuffer: 16384, signal, encoding: 'utf8' },
      );
      const parsed: unknown = JSON.parse(result.stdout.trim());
      if (!parsed || typeof parsed !== 'object' || !('directory' in parsed))
        throw new Error('Invalid picker output');
      return typeof parsed.directory === 'string' ? parsed.directory : undefined;
    } catch (error) {
      if (signal?.aborted) throw new AppError(499, '已取消目录选择');
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        '无法打开 Windows 目录选择窗口，请确认工作台由当前桌面用户运行；也可使用 ZIP 另存为',
      );
    }
  },
  async openLocation(path, file) {
    if (process.platform !== 'win32') throw new AppError(501, '打开文件位置目前仅支持 Windows');
    await run('explorer.exe', file ? [`/select,${path}`] : [path], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16384,
    }).catch((error: unknown) => {
      // Explorer commonly returns a non-zero exit after delegating to the desktop process.
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 1)
        throw new AppError(503, '无法打开文件管理器，请从所选保存目录手动查看文件');
    });
  },
  retrieve: (asset, url, signal) =>
    asset.kind === 'image' ? fetchAmazonImage(url, signal) : fetchAmazonVideo(url, signal),
};
const globalState = globalThis as typeof globalThis & {
  __productspyMediaJobs?: Map<string, JobState>;
  __productspyMediaPicker?: boolean;
  __productspyMediaPickerController?: AbortController;
};
const jobs = (globalState.__productspyMediaJobs ??= new Map());

function currentJob(id: string): JobState {
  const state = jobs.get(id);
  if (
    !state ||
    state.dataRoot !== dataDirectory() ||
    Date.parse(state.job.expiresAt) <= Date.now()
  ) {
    if (state && !state.running) jobs.delete(id);
    throw new AppError(410, '素材保存会话已过期，请重新选择保存目录；已保存文件保持不变');
  }
  return state;
}
function snapshot(state: JobState): MediaDownloadJob {
  return structuredClone(state.job);
}
async function validateDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new AppError(400, '目录选择返回了无效路径');
  const resolved = resolve(directory);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AppError(400, '请选择实际目录，不能通过链接写入其他位置');
  const actual = await realpath(resolved);
  if (actual.toLowerCase() !== resolved.toLowerCase())
    throw new AppError(400, '保存目录包含目录链接，请选择实际目录');
  return actual;
}
async function checkRoot(state: JobState): Promise<void> {
  if ((await validateDirectory(state.directory)).toLowerCase() !== state.directory.toLowerCase())
    throw new AppError(409, '保存目录发生变化，下载已停止');
}
async function writeManifest(state: JobState): Promise<void> {
  await checkRoot(state);
  const path = join(state.directory, state.job.manifestFilename);
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const contents = JSON.stringify(
    {
      schemaVersion: 1,
      product: {
        id: state.product.id,
        asin: state.product.sourceId,
        title: state.product.title,
        url: state.product.url,
        recordUpdatedAt: state.product.updatedAt,
      },
      createdAt: new Date(Date.parse(state.job.expiresAt) - JOB_LIFETIME).toISOString(),
      entries: state.job.entries,
    },
    null,
    2,
  );
  try {
    // The target includes a random job id and is never an existing user filename.
    await writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
    const targetInfo = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (targetInfo?.isSymbolicLink()) throw new AppError(409, '素材清单路径发生变化，写入已停止');
    if (targetInfo) {
      if (
        !targetInfo.isFile() ||
        !state.manifestHash ||
        targetInfo.size > 2 * 1024 * 1024 ||
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') !== state.manifestHash
      )
        throw new AppError(409, '素材来源清单已被修改，本次没有覆盖您的文件；请重新选择保存目录');
      await rename(temp, path);
    } else await link(temp, path);
    state.manifestHash = createHash('sha256').update(contents).digest('hex');
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function prepareMediaDownload(
  product: Product,
  signal?: AbortSignal,
  operations: NativeOperations = nativeOperations,
): Promise<MediaDownloadJob | undefined> {
  for (const [id, state] of jobs)
    if (!state.running && Date.parse(state.job.expiresAt) <= Date.now()) jobs.delete(id);
  if (jobs.size >= 20) throw new AppError(429, '素材保存会话过多，请稍后重试');
  if (globalState.__productspyMediaPicker)
    throw new AppError(409, '目录选择窗口已打开，请完成或取消当前选择');
  globalState.__productspyMediaPicker = true;
  const pickerController = new AbortController();
  globalState.__productspyMediaPickerController = pickerController;
  let selected: string | undefined;
  try {
    selected = await operations.chooseDirectory(
      signal ? AbortSignal.any([signal, pickerController.signal]) : pickerController.signal,
    );
    if (pickerController.signal.aborted || signal?.aborted) return undefined;
  } finally {
    globalState.__productspyMediaPicker = false;
    globalState.__productspyMediaPickerController = undefined;
  }
  if (!selected) return undefined;
  const directory = await validateDirectory(selected);
  const id = randomBytes(24).toString('hex');
  // A download session needs only capture provenance, never AI history or private edits.
  const capture: Product = {
    id: product.id,
    source: product.source,
    sourceId: product.sourceId,
    url: product.url,
    title: product.title,
    ...(product.mainImage ? { mainImage: product.mainImage } : {}),
    images: [...product.images],
    videos: structuredClone(product.videos),
    bulletPoints: [],
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    ...(product.mediaMetadata ? { mediaMetadata: structuredClone(product.mediaMetadata) } : {}),
  };
  const state: JobState = {
    product: capture,
    assets: buildProductMediaAssets(capture),
    directory,
    controller: new AbortController(),
    running: false,
    bytes: 0,
    dataRoot: dataDirectory(),
    job: {
      id,
      directory,
      expiresAt: new Date(Date.now() + JOB_LIFETIME).toISOString(),
      manifestFilename: `${product.sourceId}-素材来源-${id.slice(0, 12)}.json`,
      entries: [],
      cancelled: false,
    },
  };
  jobs.set(id, state);
  return snapshot(state);
}

export async function downloadMediaAsset(
  id: string,
  assetId: string,
  selectedUrl?: string,
  operations: NativeOperations = nativeOperations,
): Promise<MediaDownloadJob> {
  const state = currentJob(id);
  if (state.running) throw new AppError(409, '当前目录正在保存其他素材，请等待完成');
  const asset = state.assets.find((item) => item.id === assetId);
  if (!asset || !asset.downloadable)
    throw new AppError(400, '此素材不支持直接下载，请打开原始链接');
  const url = selectedUrl ?? asset.url;
  if (!asset.variants.some((variant) => variant.url === url))
    throw new AppError(400, '只能下载此商品实际采集的素材来源');
  const completed = state.job.entries.find(
    (entry) =>
      entry.assetId === assetId &&
      entry.sourceUrl === url &&
      ['saved', 'duplicate'].includes(entry.status),
  );
  if (completed?.filename && completed.sha256) {
    try {
      const path = join(state.directory, completed.filename);
      const info = await lstat(path);
      if (
        info.isFile() &&
        !info.isSymbolicLink() &&
        info.size === completed.bytes &&
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') === completed.sha256
      )
        return snapshot(state);
    } catch {
      /* An explicit retry can recreate a removed file, never replace modified content. */
    }
    state.job.entries = state.job.entries.filter((item) => item !== completed);
  }
  // Explicit retry retains successful entries; only a cancelled/failed item is requested again.
  if (state.controller.signal.aborted) state.controller = new AbortController();
  state.job.cancelled = false;
  state.running = true;
  const entry: MediaDownloadEntry = {
    assetId,
    kind: asset.kind,
    sourceUrl: url,
    sourcePage: asset.sourceUrl,
    productId: asset.productId,
    asin: asset.productSourceId,
    extractedAt: asset.extractedAt,
    extractionTimeKnown: asset.extractionTimeKnown,
    status: 'failed',
  };
  try {
    await checkRoot(state);
    const download = await operations.retrieve(asset, url, state.controller.signal);
    if (state.controller.signal.aborted) throw new AppError(499, '已取消素材下载');
    if (state.bytes + download.bytes.byteLength > MAX_JOB_BYTES)
      throw new AppError(413, '本次保存超过 300 MiB，请重新选择目录后分批下载');
    const sha256 = createHash('sha256').update(download.bytes).digest('hex');
    let duplicate = state.job.entries.find(
      (item) =>
        item.sha256 === sha256 && item.filename && ['saved', 'duplicate'].includes(item.status),
    );
    if (duplicate?.filename) {
      const existing = join(state.directory, duplicate.filename);
      try {
        const info = await lstat(existing);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size !== download.bytes.byteLength ||
          createHash('sha256')
            .update(await readFile(existing))
            .digest('hex') !== sha256
        )
          duplicate = undefined;
      } catch {
        duplicate = undefined;
      }
    }
    entry.sha256 = sha256;
    entry.bytes = download.bytes.byteLength;
    entry.contentType = download.contentType;
    if (duplicate) {
      entry.status = 'duplicate';
      entry.filename = duplicate.filename;
    } else {
      const extension = EXTENSIONS[download.contentType];
      if (!extension) throw new AppError(415, '素材类型不受支持');
      const index =
        state.assets
          .filter((item) => item.kind === asset.kind)
          .findIndex((item) => item.id === assetId) + 1;
      const initial = safeMediaFilename(
        state.product.title,
        state.product.sourceId,
        asset.kind,
        index,
        extension,
      );
      const stem = initial.slice(0, -(extension.length + 1));
      const filename = `${stem}-${sha256.slice(0, 12)}.${extension}`;
      const target = join(state.directory, filename);
      if (dirname(target) !== state.directory || basename(target) !== filename)
        throw new AppError(400, '素材文件名无效');
      await checkRoot(state);
      const temp = join(state.directory, `.productspy-${randomBytes(12).toString('hex')}.tmp`);
      try {
        await writeFile(temp, download.bytes, {
          flag: 'wx',
          mode: 0o600,
          signal: state.controller.signal,
        });
        if (state.controller.signal.aborted) throw new AppError(499, '已取消素材下载');
        await checkRoot(state);
        // Hard-link publication is atomic and fails if the final name already exists.
        await link(temp, target);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
          throw error;
        const info = await lstat(target);
        if (
          info.isSymbolicLink() ||
          !info.isFile() ||
          info.size !== download.bytes.byteLength ||
          createHash('sha256')
            .update(await readFile(target))
            .digest('hex') !== sha256
        )
          throw new AppError(409, '已有同名文件内容不同，本次没有覆盖任何文件');
        entry.status = 'duplicate';
      } finally {
        await unlink(temp).catch(() => undefined);
      }
      entry.filename = filename;
      if (entry.status !== 'duplicate') entry.status = 'saved';
      state.bytes += download.bytes.byteLength;
    }
  } catch (error) {
    entry.status = state.controller.signal.aborted ? 'cancelled' : 'failed';
    entry.error =
      error instanceof AppError ? error.message : '目录不可写或文件保存失败，请检查权限后重试';
  } finally {
    state.job.entries = state.job.entries.filter(
      (item) => !(item.assetId === assetId && item.sourceUrl === url),
    );
    state.job.entries.push(entry);
    try {
      await writeManifest(state);
    } catch (error) {
      entry.error = `${entry.error ? `${entry.error}；` : ''}${error instanceof AppError ? error.message : '素材来源清单无法写入，请检查目录权限或使用支持原子写入的 NTFS 目录'}`;
    }
    state.running = false;
  }
  return snapshot(state);
}

export function cancelMediaDownload(id: string): MediaDownloadJob {
  const state = currentJob(id);
  state.controller.abort();
  state.job.cancelled = true;
  return snapshot(state);
}
export function cancelMediaDirectoryPicker(): void {
  globalState.__productspyMediaPickerController?.abort();
}
export async function openMediaLocation(
  id: string,
  assetId?: string,
  operations: NativeOperations = nativeOperations,
): Promise<void> {
  const state = currentJob(id);
  await checkRoot(state);
  if (!assetId) return operations.openLocation(state.directory, false);
  const entry = state.job.entries.find(
    (item) =>
      item.assetId === assetId && item.filename && ['saved', 'duplicate'].includes(item.status),
  );
  if (!entry?.filename) throw new AppError(404, '此素材尚未保存成功');
  const path = join(state.directory, entry.filename);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new AppError(409, '素材文件不存在或路径发生变化');
  await operations.openLocation(path, true);
}
export function mediaDirectoryAvailable(): boolean {
  return process.platform === 'win32';
}
