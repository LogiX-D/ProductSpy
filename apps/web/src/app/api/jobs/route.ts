import { listJobs, enqueueAIJob } from '../../../lib/saas/jobs';
import { withApiRequest, readJsonBody } from '../../../lib/server/http';
import { currentUserId } from '../../../lib/saas/context';
import { AppError } from '../../../lib/server/errors';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  const response = await withApiRequest(
    request,
    () => {
      const parameters = new URL(request.url).searchParams;
      const limit = parameters.get('limit');
      if (
        parameters.getAll('limit').length > 1 ||
        parameters.getAll('cursor').length > 1 ||
        (limit !== null && !/^[1-9]\d{0,2}$/.test(limit))
      )
        throw new AppError(400, '任务分页参数无效，每页可查看 1–200 条');
      return listJobs({
        ...(limit !== null ? { limit: Number(limit) } : {}),
        ...(parameters.has('cursor') ? { cursor: parameters.get('cursor')! } : {}),
      });
    },
    { webOnly: true },
  );
  if (response.ok && process.env.PRODUCTSPY_JOB_RUNNER !== 'external') {
    const timer = setTimeout(() => {
      void import('../../../lib/saas/job-worker')
        .then((module) => module.runPendingAIJobsOnce())
        .catch(() => console.error('[ProductSpy jobs] Inline queue recovery failed'));
    }, 0);
    timer.unref();
  }
  return response;
}
export async function POST(request: Request) {
  let queued: { user: string; id: string } | undefined;
  const response = await withApiRequest(
    request,
    async () => {
      const job = await enqueueAIJob(await readJsonBody(request, 256 * 1024));
      if (job.status === 'queued') queued = { user: currentUserId(), id: job.id };
      return job;
    },
    { write: true, webOnly: true, status: 202 },
  );
  // Inline runner is for one-process development. Production uses the independent worker.
  if (queued && process.env.PRODUCTSPY_JOB_RUNNER !== 'external') {
    const task = queued;
    const timer = setTimeout(() => {
      void import('../../../lib/saas/job-worker')
        .then((module) => module.runAIJob(task.user, task.id))
        .catch(() => console.error('[ProductSpy jobs] Inline task execution failed'));
    }, 0);
    timer.unref();
  }
  return response;
}
