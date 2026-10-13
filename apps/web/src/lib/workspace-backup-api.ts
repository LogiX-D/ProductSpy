import {
  parseWorkspaceBackup,
  workspacePreferencesSchema,
  type WorkspaceBackup,
  type WorkspaceBackupPreview,
  type WorkspacePreferences,
  type WorkspaceBackupCounts,
} from '@productspy/shared';
import { webRequest } from './session';
export const WORKSPACE_PREFERENCE_KEYS = {
  library: 'productspy:library-preferences:v1',
  analysis: 'productspy:analysis-preferences:v1',
  content: 'productspy:content-preferences:v1',
  builtinFavorites: 'productspy:builtin-template-favorites:v1',
} as const;
/** Only named, independently validated business preferences are exported. Never enumerate localStorage. */
export function readBackupPreferences(storage: Pick<Storage, 'getItem'>): WorkspacePreferences {
  const result: WorkspacePreferences = {};
  for (const [kind, key] of Object.entries(WORKSPACE_PREFERENCE_KEYS)) {
    try {
      const raw = storage.getItem(key);
      if (!raw || raw.length > 24000) continue;
      const parsed = workspacePreferencesSchema.safeParse({ [kind]: JSON.parse(raw) as unknown });
      if (parsed.success) Object.assign(result, parsed.data);
    } catch {
      /* A malformed optional preference is not allowed into a portable backup. */
    }
  }
  return result;
}
export function restoreBackupPreferences(value: unknown, storage: Pick<Storage, 'setItem'>): void {
  const checked = workspacePreferencesSchema.parse(value);
  for (const [kind, key] of Object.entries(WORKSPACE_PREFERENCE_KEYS)) {
    const preference = checked[kind as keyof WorkspacePreferences];
    if (preference !== undefined) storage.setItem(key, JSON.stringify(preference));
  }
}
export interface WorkspaceRestoreResponse {
  preview: WorkspaceBackupPreview;
  committed: boolean;
  imported?: number;
  skipped?: number;
  preferences?: WorkspacePreferences;
}
export function workspaceStatus(): Promise<{
  counts: WorkspaceBackupCounts;
  revision: string;
  bytes: number;
}> {
  return webRequest('/api/workspace-backup?status=1');
}
export async function exportWorkspaceBackup(): Promise<WorkspaceBackup> {
  return parseWorkspaceBackup(
    await webRequest<unknown>('/api/workspace-backup', { signal: AbortSignal.timeout(120000) }),
  );
}
export function restoreWorkspaceBackup(
  backup: WorkspaceBackup,
  options: {
    commit?: boolean;
    confirmed?: boolean;
    policy?: 'skip' | 'preserve';
    expectedRevision?: string;
  },
  signal?: AbortSignal,
): Promise<WorkspaceRestoreResponse> {
  return webRequest('/api/workspace-backup', {
    method: 'POST',
    body: JSON.stringify({ backup, ...options }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000),
  });
}
