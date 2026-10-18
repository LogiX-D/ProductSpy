import { query, dbTransaction } from './database';
import { currentUserId } from './context';
import { consumeAIAllowance } from './entitlements';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppError } from '../server/errors';

export async function startAIJob(id: string, kind: string): Promise<void> {
  await query(
    "INSERT INTO jobs(user_id,id,kind,status,created_at,updated_at) VALUES($1,$2,$3,'running',now(),now()) ON CONFLICT(user_id,id) DO UPDATE SET status='running',updated_at=now() WHERE jobs.status IN ('queued','running')",
    [currentUserId(), id, kind],
  );
}
const queueSchema = z
  .object({
    endpoint: z.enum(['/api/analyze-product', '/api/analyze-comparison', '/api/generate-content']),
    input: z.object({ requestId: z.string().uuid() }).passthrough(),
  })
  .strict();
export async function enqueueAIJob(body: unknown) {
  const parsed = queueSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, '后台任务类型或请求编号无效');
  const payload = parsed.data,
    id = payload.input.requestId,
    user = currentUserId();
  if (
    (process.env.AI_MODE === 'real' ||
      (process.env.AI_MODE !== 'mock' && process.env.AI_API_KEY?.trim())) &&
    payload.input.authorizeReal !== true
  )
    throw new AppError(428, '请先确认真实 AI 请求及其预算');
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return dbTransaction(async () => {
    const existing = await query<{ payload: { fingerprint?: string }; status: string }>(
      'SELECT payload,status FROM jobs WHERE user_id=$1 AND id=$2',
      [user, id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].payload.fingerprint !== fingerprint)
        throw new AppError(409, '此请求编号已用于不同任务');
      return { id, status: existing.rows[0].status, replayed: true };
    }
    await consumeAIAllowance(id);
    const kind =
      payload.endpoint === '/api/analyze-product'
        ? 'analysis'
        : payload.endpoint === '/api/analyze-comparison'
          ? 'comparison'
          : 'content';
    await query(
      "INSERT INTO jobs(user_id,id,kind,status,payload) VALUES($1,$2,$3,'queued',$4::jsonb)",
      [user, id, kind, JSON.stringify({ ...payload, fingerprint })],
    );
    await query('INSERT INTO job_dispatch(user_id,id) VALUES($1,$2)', [user, id]);
    return { id, status: 'queued', replayed: false };
  });
}
export async function getJob(id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new AppError(400, '任务编号无效');
  const { rows } = await query<{
    id: string;
    status: string;
    result: unknown;
    error: string | null;
  }>('SELECT id,status,result,error FROM jobs WHERE user_id=$1 AND id=$2', [currentUserId(), id]);
  if (!rows[0]) throw new AppError(404, '任务不存在');
  return rows[0];
}
export async function finishAIJob(id: string, status: string, errorCode?: number): Promise<void> {
  const succeeded = status === 'succeeded';
  await query(
    "UPDATE jobs SET status=CASE WHEN payload ? 'endpoint' THEN status ELSE $1 END,error=$2,updated_at=now() WHERE user_id=$3 AND id=$4",
    [
      succeeded ? 'succeeded' : 'failed',
      succeeded ? null : `请求未完成（${errorCode ?? 'unknown'}），检查已保存结果后手动重试`,
      currentUserId(),
      id,
    ],
  );
}
const historyPageSchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.number().int().min(1).max(200).default(200),
  })
  .strict();
const historyCursorSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().min(1).max(200),
    createdAt: z.string().datetime({ precision: 6 }),
    id: z
      .string()
      .min(1)
      .max(200)
      .refine((id) => !id.includes('\0')),
  })
  .strict();

export async function listJobs(options: { cursor?: string; limit?: number } = {}) {
  const parsed = historyPageSchema.safeParse(options);
  if (!parsed.success) throw new AppError(400, '任务分页参数无效，每页可查看 1–200 条');
  const { cursor, limit } = parsed.data;
  const userId = currentUserId();
  let anchor: z.infer<typeof historyCursorSchema> | undefined;
  if (cursor) {
    try {
      const text = Buffer.from(cursor, 'base64url').toString('utf8');
      if (Buffer.from(text, 'utf8').toString('base64url') !== cursor)
        throw new Error('Invalid encoding');
      anchor = historyCursorSchema.parse(JSON.parse(text));
      if (anchor.userId !== userId) throw new Error('Cursor belongs to a different account');
    } catch {
      throw new AppError(400, '任务分页游标无效，请刷新任务记录');
    }
  }
  await query(
    "UPDATE jobs SET status='interrupted',error='服务中断，结果和费用可能未知；不会自动重新调用 AI',updated_at=now() WHERE user_id=$1 AND status='running' AND updated_at<now()-interval '10 minutes'",
    [userId],
  );
  const { rows } = await query<{
    id: string;
    kind: string;
    status: string;
    created_at: string | Date;
    cursor_created_at: string;
    updated_at: string | Date;
    error: string | null;
  }>(
    `SELECT id,kind,status,created_at,updated_at,error,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM jobs WHERE user_id=$1
      ${anchor ? 'AND (created_at,id)<($2::timestamptz,$3::text)' : ''}
      ORDER BY created_at DESC,id DESC LIMIT ${anchor ? '$4' : '$2'}`,
    anchor ? [userId, anchor.createdAt, anchor.id, limit + 1] : [userId, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    jobs: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      ...(row.error ? { error: row.error } : {}),
    })),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              userId,
              // Preserve PostgreSQL microseconds; a JavaScript Date would lose the boundary.
              createdAt: last.cursor_created_at,
              id: last.id,
            }),
          ).toString('base64url')
        : null,
  };
}
