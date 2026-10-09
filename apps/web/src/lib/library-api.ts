import {
  librarySnapshotSchema,
  libraryBatchResultSchema,
  type LibrarySnapshot,
  type LibraryDefinitionRequest,
  type LibraryBatchRequest,
  type LibraryExportFile,
} from '@productspy/shared';
import { webRequest } from './session';
import { webCache } from './storage/web-storage';

export async function fetchLibrary(): Promise<LibrarySnapshot> {
  const snapshot = librarySnapshotSchema.parse(await webRequest<unknown>('/api/library'));
  try {
    await webCache.replace(snapshot.products);
  } catch (cause) {
    console.warn('[ProductSpy] Library cache write failed', cause);
  }
  return snapshot;
}
export async function updateLibraryDefinition(request: LibraryDefinitionRequest) {
  return webRequest<unknown>('/api/library', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}
export async function batchLibraryProducts(request: LibraryBatchRequest) {
  return libraryBatchResultSchema.parse(
    await webRequest<unknown>('/api/library/batch', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  );
}

export type LibraryExportFormat = 'json' | 'csv' | 'markdown';
export async function exportLibrary(format: LibraryExportFormat, ids?: string[]) {
  if (ids)
    return webRequest<LibraryExportFile>('/api/library/export', {
      method: 'POST',
      body: JSON.stringify({ format, ids }),
    });
  return webRequest<LibraryExportFile>(`/api/library/export?format=${format}`);
}
export function downloadLibraryFile(result: LibraryExportFile) {
  const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
