'use client';
import { useCallback, useEffect, useState } from 'react';
import { getJobs } from '../lib/saas-api';
import type { AccountJob } from '../lib/saas-types';
import { Button, EmptyState, ErrorNotice, LoadingState, PageHeading } from './ui';

const states: Record<string, string> = {
  pending: '等待处理',
  queued: '等待处理',
  started: '执行中',
  running: '执行中',
  succeeded: '已完成',
  completed: '已完成',
  failed: '失败',
  interrupted: '中断',
  conflict: '版本冲突',
  cancelled: '已取消',
};
const kinds: Record<string, string> = {
  product: '商品分析',
  analyze_product: '商品分析',
  analysis: '商品分析',
  comparison: '竞品对比',
  content: '内容创作',
  generate_content: '内容创作',
};
export function TasksWorkspace() {
  const [jobs, setJobs] = useState<AccountJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await getJobs();
      if (!signal?.aborted) {
        setJobs(result.jobs);
        setError('');
      }
    } catch (cause) {
      if (!signal?.aborted)
        setError(cause instanceof Error ? cause.message : '任务记录暂时不可用。');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload(controller.signal);
    }, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [reload]);
  return (
    <div className="ws-page">
      <PageHeading title="任务记录" description="查看商品分析、对比和内容创作请求的执行状态。" />
      <p className="small muted">
        请求由服务端执行并保存状态。连接中断后，先检查对应商品或内容中的已保存结果，再决定是否新建请求。
      </p>
      <div>
        <Button variant="secondary" onClick={() => void reload()}>
          刷新任务
        </Button>
      </div>
      {error && <ErrorNotice message={error} />}
      {loading ? (
        <LoadingState />
      ) : jobs.length === 0 ? (
        <EmptyState
          title="暂无任务"
          description="开始商品分析或内容创作后，会在这里保留请求记录。"
        />
      ) : (
        <div className="saas-table-wrap panel">
          <table className="saas-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>最后更新</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <strong>{kinds[job.kind] ?? job.kind}</strong>
                    <small>{job.id}</small>
                  </td>
                  <td>{states[job.status] ?? job.status}</td>
                  <td>{new Date(job.createdAt).toLocaleString('zh-CN')}</td>
                  <td>{new Date(job.updatedAt).toLocaleString('zh-CN')}</td>
                  <td>{job.error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
