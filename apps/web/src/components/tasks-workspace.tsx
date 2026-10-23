'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const cursor = cursors.at(-1);
  const reload = useCallback(
    async (background = false) => {
      if (background && activeRequest.current) return;
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const sequence = ++requestSequence.current;
      if (!background) setLoading(true);
      try {
        const result = await getJobs({ cursor, limit: 50, signal: controller.signal });
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          setJobs(result.jobs);
          setNextCursor(result.nextCursor ?? undefined);
          setError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted && sequence === requestSequence.current)
          setError(cause instanceof Error ? cause.message : '任务记录暂时不可用。');
      } finally {
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          setLoading(false);
          activeRequest.current = undefined;
        }
      }
    },
    [cursor],
  );
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload(true);
    }, 5000);
    return () => {
      requestSequence.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = undefined;
      window.clearInterval(timer);
    };
  }, [reload]);
  function changePage(next: (string | undefined)[]) {
    requestSequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = undefined;
    setJobs([]);
    setNextCursor(undefined);
    setError('');
    setLoading(true);
    setCursors(next);
  }
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
      <nav aria-label="任务分页" className="saas-task-pagination">
        <Button
          variant="secondary"
          disabled={loading || cursors.length === 1}
          onClick={() => changePage(cursors.slice(0, -1))}
        >
          上一页
        </Button>
        <span role="status">
          第 {cursors.length} 页 · 本页 {jobs.length} 条
        </span>
        <Button
          variant="secondary"
          disabled={loading || !nextCursor}
          onClick={() => nextCursor && changePage([...cursors, nextCursor])}
        >
          下一页
        </Button>
      </nav>
    </div>
  );
}
