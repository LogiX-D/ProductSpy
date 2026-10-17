import { resolve } from 'node:path';
import { currentUserId, tenantDirectory } from './context';
import { dbTransaction, query } from './database';
import { assertProductCount } from './entitlements';

export const WORKSPACE_DOCUMENTS = [
  'products.json',
  'templates.json',
  'comparisons.json',
  'content-plans.json',
  'analysis-usage.json',
] as const;
type DocumentName = (typeof WORKSPACE_DOCUMENTS)[number];
function checkScope(directory: string, name: string): asserts name is DocumentName {
  if (resolve(directory) !== tenantDirectory())
    throw new Error('Repository belongs to another tenant scope.');
  if (!(WORKSPACE_DOCUMENTS as readonly string[]).includes(name))
    throw new Error('Unknown workspace document.');
}
export async function readWorkspaceDocument(directory: string, name: string): Promise<string> {
  checkScope(directory, name);
  const result = await query<{ payload: unknown }>(
    'SELECT payload FROM workspace_documents WHERE user_id=$1 AND name=$2',
    [currentUserId(), name],
  );
  if (!result.rows.length) {
    const error = new Error('Workspace document does not exist') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  }
  return JSON.stringify(result.rows[0].payload);
}
export async function writeWorkspaceDocument(
  directory: string,
  name: string,
  text: string,
): Promise<void> {
  checkScope(directory, name);
  const parsed: unknown = JSON.parse(text);
  if (name === 'products.json') {
    const count = (payload: unknown): number => {
      if (Array.isArray(payload)) return payload.length;
      if (
        payload &&
        typeof payload === 'object' &&
        'products' in payload &&
        Array.isArray(payload.products)
      )
        return payload.products.length;
      throw new Error('Invalid product document.');
    };
    const existing = await query<{ payload: unknown }>(
      'SELECT payload FROM workspace_documents WHERE user_id=$1 AND name=$2',
      [currentUserId(), name],
    );
    await assertProductCount(
      count(parsed),
      existing.rows.length ? count(existing.rows[0].payload) : 0,
    );
  }
  await query(
    'INSERT INTO workspace_documents(user_id,name,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(user_id,name) DO UPDATE SET payload=excluded.payload,updated_at=now()',
    [currentUserId(), name, JSON.stringify(parsed)],
  );
}
export async function commitWorkspaceDocuments(
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  // Parse and scope-check every document before issuing a write.
  for (const [name, text] of Object.entries(files)) {
    checkScope(directory, name);
    JSON.parse(text);
  }
  await dbTransaction(async () => {
    for (const [name, text] of Object.entries(files))
      await writeWorkspaceDocument(directory, name, text);
  });
}
