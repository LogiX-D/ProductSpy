import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Product } from '@productspy/shared';
import {
  cancelMediaDownload,
  cancelMediaDirectoryPicker,
  downloadMediaAsset,
  openMediaLocation,
  prepareMediaDownload,
} from './media-downloads';
import { POST } from '../../app/api/media/downloads/route';
import { webHeaders } from './test-auth';

let directory: string;
const image = 'https://m.media-amazon.com/images/I/one.jpg';
const otherImage = 'https://m.media-amazon.com/images/I/two.jpg';
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const product: Product = {
  id: 'product',
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: '咖啡机 / Kitchen',
  images: [image, otherImage],
  videos: [],
  bulletPoints: [],
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
};
const operations = () => ({
  chooseDirectory: vi.fn(async () => directory),
  openLocation: vi.fn(async (_path: string, _file: boolean) => undefined),
  retrieve: vi.fn(async () => ({ bytes, contentType: 'image/jpeg', filename: 'source.jpg' })),
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'productspy-media-downloads-'));
  vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('explicit native directory and bounded download jobs', () => {
  it('writes only to the server-picked directory with source metadata, hash and safe filename', async () => {
    const ops = operations();
    const job = await prepareMediaDownload(product, undefined, ops);
    expect(job).toBeDefined();
    const result = await downloadMediaAsset(job!.id, 'image-1', image, ops);
    expect(result.entries[0]).toMatchObject({
      status: 'saved',
      asin: product.sourceId,
      sourcePage: product.url,
      extractedAt: product.updatedAt,
      bytes: bytes.byteLength,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.entries[0].filename).toContain('-B012345678-图片-01-');
    expect(await readFile(join(directory, result.entries[0].filename!))).toEqual(
      Buffer.from(bytes),
    );
    const manifest = JSON.parse(
      await readFile(join(directory, result.manifestFilename), 'utf8'),
    ) as { entries: unknown[] };
    expect(manifest.entries).toHaveLength(1);
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
  it('deduplicates identical content from different URLs and safely replays successful requests', async () => {
    const ops = operations();
    const job = (await prepareMediaDownload(product, undefined, ops))!;
    const first = await downloadMediaAsset(job.id, 'image-1', image, ops);
    const second = await downloadMediaAsset(job.id, 'image-2', otherImage, ops);
    expect(second.entries[1]).toMatchObject({
      status: 'duplicate',
      filename: first.entries[0].filename,
    });
    await downloadMediaAsset(job.id, 'image-1', image, ops);
    expect(ops.retrieve).toHaveBeenCalledTimes(2);
    expect((await readdir(directory)).filter((name) => name.endsWith('.jpg'))).toHaveLength(1);
  });
  it('retains successful files when another item fails and retries only the failed item', async () => {
    const ops = operations();
    const job = (await prepareMediaDownload(product, undefined, ops))!;
    const first = await downloadMediaAsset(job.id, 'image-1', image, ops);
    ops.retrieve.mockRejectedValueOnce(new Error('network disconnected'));
    const failed = await downloadMediaAsset(job.id, 'image-2', otherImage, ops);
    expect(failed.entries.map((entry) => entry.status)).toEqual(['saved', 'failed']);
    const recovered = await downloadMediaAsset(job.id, 'image-2', otherImage, ops);
    expect(recovered.entries.map((entry) => entry.status)).toEqual(['saved', 'duplicate']);
    expect(await readFile(join(directory, first.entries[0].filename!))).toEqual(Buffer.from(bytes));
  });
  it('cancels an in-flight download and permits an explicit later retry', async () => {
    const ops = operations();
    const job = (await prepareMediaDownload(product, undefined, ops))!;
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const waiting = {
      ...ops,
      retrieve: async (_asset: unknown, _url: string, signal: AbortSignal) => {
        notifyStarted();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
        );
        return { bytes, contentType: 'image/jpeg', filename: 'source.jpg' };
      },
    };
    const pending = downloadMediaAsset(job.id, 'image-1', image, waiting);
    await started;
    cancelMediaDownload(job.id);
    expect((await pending).entries[0].status).toBe('cancelled');
    expect((await readdir(directory)).filter((name) => name.endsWith('.jpg'))).toHaveLength(0);
    expect((await downloadMediaAsset(job.id, 'image-1', image, ops)).entries[0].status).toBe(
      'saved',
    );
  });
  it('never replaces an existing different file', async () => {
    const ops = operations();
    const job = (await prepareMediaDownload(product, undefined, ops))!;
    const first = await downloadMediaAsset(job.id, 'image-1', image, ops);
    const filename = first.entries[0].filename!;
    await writeFile(join(directory, filename), 'user file');
    const next = (await prepareMediaDownload(product, undefined, ops))!;
    const result = await downloadMediaAsset(next.id, 'image-1', image, ops);
    expect(result.entries[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('没有覆盖'),
    });
    expect(await readFile(join(directory, filename), 'utf8')).toBe('user file');
  });
  it('preserves a manually modified manifest and reports the metadata failure', async () => {
    const ops = operations();
    const job = (await prepareMediaDownload(product, undefined, ops))!;
    await downloadMediaAsset(job.id, 'image-1', image, ops);
    const path = join(directory, job.manifestFilename);
    await writeFile(path, 'user edited manifest');
    const result = await downloadMediaAsset(job.id, 'image-2', otherImage, ops);
    expect(result.entries[1]).toMatchObject({
      status: 'duplicate',
      error: expect.stringContaining('清单已被修改'),
    });
    expect(await readFile(path, 'utf8')).toBe('user edited manifest');
  });
  it('does not accept arbitrary assets, URLs, paths or cross-data-root jobs', async () => {
    const ops = operations();
    const job = (await prepareMediaDownload(product, undefined, ops))!;
    await expect(downloadMediaAsset(job.id, 'image-999', image, ops)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      downloadMediaAsset(job.id, 'image-1', 'https://m.media-amazon.com/uncollected.jpg', ops),
    ).rejects.toMatchObject({ status: 400 });
    expect(ops.retrieve).not.toHaveBeenCalled();
    vi.stubEnv('PRODUCTSPY_DATA_DIR', join(directory, 'other'));
    await expect(downloadMediaAsset(job.id, 'image-1', image, ops)).rejects.toMatchObject({
      status: 410,
    });
  });
  it('opens only an existing job-owned file or its selected directory', async () => {
    const ops = operations();
    const job = (await prepareMediaDownload(product, undefined, ops))!;
    await expect(openMediaLocation(job.id, 'image-1', ops)).rejects.toMatchObject({ status: 404 });
    const result = await downloadMediaAsset(job.id, 'image-1', image, ops);
    await openMediaLocation(job.id, 'image-1', ops);
    expect(ops.openLocation).toHaveBeenCalledWith(
      join(directory, result.entries[0].filename!),
      true,
    );
    await openMediaLocation(job.id, undefined, ops);
    expect(ops.openLocation).toHaveBeenCalledWith(directory, false);
  });
  it('cancelled directory selection writes nothing', async () => {
    const ops = { ...operations(), chooseDirectory: async () => undefined };
    expect(await prepareMediaDownload(product, undefined, ops)).toBeUndefined();
    expect(await readdir(directory)).toHaveLength(0);
  });
  it('cancels an active directory picker and never accepts its late selection', async () => {
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const ops = {
      ...operations(),
      chooseDirectory: async (signal?: AbortSignal) => {
        notifyStarted();
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        return directory;
      },
    };
    const pending = prepareMediaDownload(product, undefined, ops);
    await started;
    cancelMediaDirectoryPicker();
    expect(await pending).toBeUndefined();
    expect(await readdir(directory)).toHaveLength(0);
  });
  it('verifies saved files before replaying or reusing hashes', async () => {
    const ops = operations();
    const job = (await prepareMediaDownload(product, undefined, ops))!;
    const first = await downloadMediaAsset(job.id, 'image-1', image, ops);
    const path = join(directory, first.entries[0].filename!);
    await unlink(path);
    const restored = await downloadMediaAsset(job.id, 'image-1', image, ops);
    expect(restored.entries[0].status).toBe('saved');
    expect(ops.retrieve).toHaveBeenCalledTimes(2);
    await writeFile(path, 'manually modified');
    const next = await downloadMediaAsset(job.id, 'image-2', otherImage, ops);
    expect(next.entries[1].status).toBe('saved');
    expect(next.entries[1].filename).not.toBe(first.entries[0].filename);
    expect(await readFile(path, 'utf8')).toBe('manually modified');
    const conflict = await downloadMediaAsset(job.id, 'image-1', image, ops);
    expect(conflict.entries.find((entry) => entry.assetId === 'image-1')).toMatchObject({
      status: 'duplicate',
      filename: next.entries[1].filename,
    });
    expect(await readFile(path, 'utf8')).toBe('manually modified');
  });
  it('rejects a non-directory picker result before saving files', async () => {
    const path = join(directory, 'user.txt');
    await writeFile(path, 'existing');
    await expect(
      prepareMediaDownload(product, undefined, {
        ...operations(),
        chooseDirectory: async () => path,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(path, 'utf8')).toBe('existing');
  });
  it('rejects arbitrary browser filesystem paths and hostile origins before opening a dialog', async () => {
    const request = new Request('http://localhost:3000/api/media/downloads', {
      method: 'POST',
      headers: webHeaders(),
      body: JSON.stringify({ action: 'prepare', productId: product.id, directory: directory }),
    });
    expect((await POST(request)).status).toBe(400);
    const hostile = new Request('http://localhost:3000/api/media/downloads', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
        'X-ProductSpy-Client': 'web',
      },
      body: '{}',
    });
    expect((await POST(hostile)).status).toBe(403);
  });
});
