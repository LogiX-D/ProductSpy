import { historySummarySchema, type HistoryKind, type HistorySummary } from '@productspy/shared';
import { webRequest } from './session';

export async function getHistorySummary(kind: HistoryKind, id: string): Promise<HistorySummary> {
  return historySummarySchema.parse(
    await webRequest<unknown>(`/api/history?kind=${kind}&id=${encodeURIComponent(id)}`),
  );
}
export async function archiveHistory(input: {
  kind: HistoryKind;
  id: string;
  expectedUpdatedAt: string;
  versionIds: string[];
}): Promise<{ archive: unknown; archiveReceipt: string; sha256: string }> {
  return webRequest('/api/history/archive', { method: 'POST', body: JSON.stringify(input) });
}
export async function cleanupHistory(input: {
  kind: HistoryKind;
  id: string;
  expectedUpdatedAt: string;
  versionIds: string[];
  confirmed: true;
  archiveReceipt: string;
}): Promise<{ removed: number; summary: HistorySummary }> {
  const result = await webRequest<{ removed: number; summary: unknown }>('/api/history', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return { removed: result.removed, summary: historySummarySchema.parse(result.summary) };
}
