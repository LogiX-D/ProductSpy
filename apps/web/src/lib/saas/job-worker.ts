import { POST as analyzeProduct } from '../../app/api/analyze-product/route';
import { POST as analyzeComparison } from '../../app/api/analyze-comparison/route';
import { POST as generateContent } from '../../app/api/generate-content/route';
import { withTenant } from './context';
import { query, dbTransaction } from './database';
import { appOrigin } from './config';
import { withTaskIdentity } from './task-identity';
import type { AccountUser } from './security';
import { workerConcurrency } from './runtime-limits';
import { resolvedAIExecutionSchema } from './job-input';
import { verifyAIExecution, withAIExecution } from '../ai/channels';
import { AppError } from '../server/errors';

const handlers = {
  '/api/analyze-product': analyzeProduct,
  '/api/analyze-comparison': analyzeComparison,
  '/api/generate-content': generateContent,
};
export async function runAIJob(userId: string, id: string): Promise<boolean> {
  return withTenant(userId, async () => {
    const jobs = await query<{
      payload: { endpoint: keyof typeof handlers; input: unknown; execution?: unknown };
      status: string;
    }>('SELECT payload,status FROM jobs WHERE user_id=$1 AND id=$2', [userId, id]);
    const job = jobs.rows[0];
    if (!job || job.status !== 'queued') return false;
    const users = await query<{
      id: string;
      email: string;
      name: string;
      created_at: string | Date;
    }>('SELECT id,email,name,created_at FROM users WHERE id=$1', [userId]);
    const row = users.rows[0];
    if (!row) return false;
    await dbTransaction(async () => {
      await query(
        "UPDATE jobs SET status='running',attempts=attempts+1,updated_at=now() WHERE user_id=$1 AND id=$2",
        [userId, id],
      );
      await query('DELETE FROM job_dispatch WHERE user_id=$1 AND id=$2', [userId, id]);
    });
    try {
      const user: AccountUser = {
        id: row.id,
        email: row.email,
        name: row.name,
        createdAt: new Date(row.created_at).toISOString(),
      };
      const origin = appOrigin(),
        endpoint = job.payload.endpoint;
      const handler = handlers[endpoint];
      if (!handler) throw new Error('Invalid persisted task endpoint');
      const execution = resolvedAIExecutionSchema.safeParse(job.payload.execution);
      if (!execution.success)
        throw new AppError(503, '历史任务缺少已确认的 AI 渠道快照，请核对用量后手动新建请求。');
      await verifyAIExecution(execution.data);
      const response = await withAIExecution(execution.data, () =>
        withTaskIdentity(user, id, () =>
          handler(
            new Request(`${origin}${endpoint}`, {
              method: 'POST',
              headers: {
                Host: new URL(origin).host,
                Origin: origin,
                'Content-Type': 'application/json',
                'X-ProductSpy-Client': 'web',
                'Sec-Fetch-Site': 'same-origin',
              },
              body: JSON.stringify(job.payload.input),
            }),
          ),
        ),
      );
      const body: unknown = await response.json();
      await query(
        'UPDATE jobs SET status=$1,result=$2::jsonb,error=$3,updated_at=now() WHERE user_id=$4 AND id=$5',
        [
          response.ok ? 'succeeded' : 'failed',
          JSON.stringify({ status: response.status, body }),
          response.ok ? null : `生成失败 (${response.status})；不会自动重新调用 AI`,
          userId,
          id,
        ],
      );
    } catch (error) {
      await query(
        "UPDATE jobs SET status='failed',error=$1,updated_at=now() WHERE user_id=$2 AND id=$3",
        [
          error instanceof AppError && error.status === 503
            ? 'AI 渠道配置已变更、停用或缺少历史执行快照；未调用 AI，不会自动切换渠道，请核对用量后手动新建请求'
            : '执行异常，结果或费用可能未知；请核对已保存结果，不会自动重试',
          userId,
          id,
        ],
      );
    }
    return true;
  });
}
export async function runPendingAIJobsOnce(limit = workerConcurrency()): Promise<number> {
  const concurrency = workerConcurrency();
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new Error('Worker batch limit must be an integer between 1 and 10.');
  const rows = await query<{ user_id: string; id: string }>(
    'SELECT user_id,id FROM job_dispatch ORDER BY created_at LIMIT $1',
    [Math.min(concurrency, limit)],
  );
  const outcomes = await Promise.all(rows.rows.map((job) => runAIJob(job.user_id, job.id)));
  return outcomes.filter(Boolean).length;
}
