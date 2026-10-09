import type { AnalysisUsageReport } from '@productspy/shared';
import { Button } from './ui';

export function AnalysisUsagePanel({
  report,
  error,
  loading,
  onRefresh,
}: {
  report?: AnalysisUsageReport;
  error: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <details className="analysis-usage">
      <summary>
        <strong>本机用量记录</strong>
        <span>{report ? `${report.totals.realRequests} 次真实 AI 请求` : '未读取'}</span>
      </summary>
      <p className="analysis-field-hint">
        记录只保存在本机。刷新用量不会调用外部模型。费用按你填写的单价估算，以服务商账单为准。
      </p>
      <Button variant="ghost" onClick={onRefresh} disabled={loading}>
        {loading ? '正在读取…' : '刷新用量'}
      </Button>
      {error && (
        <p role="status" className="analysis-storage-warning">
          {error}
        </p>
      )}
      {report && (
        <>
          <dl className="analysis-usage-totals">
            <div>
              <dt>请求总数 / 真实 AI</dt>
              <dd>
                {report.totals.requests} / {report.totals.realRequests}
              </dd>
            </div>
            <div>
              <dt>已知输入 / 输出 Token</dt>
              <dd>
                {report.totals.inputTokens.toLocaleString()} /{' '}
                {report.totals.outputTokens.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>已知费用估算（USD）</dt>
              <dd>${report.totals.costUsd.toFixed(6)}</dd>
            </div>
          </dl>
          <p className="analysis-field-hint">
            {report.totals.unknownTokenRequests} 次请求用量未知 ·{' '}
            {report.totals.unknownCostRequests} 次请求费用未知。未知不能视为免费。今日真实请求{' '}
            {report.limits.dailyRealRequests} / {report.limits.dailyLimit}。
          </p>
          <div className="analysis-usage-records">
            {report.records.slice(0, 10).map((record) => (
              <div key={record.id}>
                <span>
                  {new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })} ·{' '}
                  {record.mode === 'mock' ? '本机演示' : '真实 AI'} ·{' '}
                  {
                    (
                      {
                        started: '已发起 / 完成状态未确认',
                        succeeded: '成功',
                        failed: '失败',
                        conflict: '版本冲突',
                      } as const
                    )[record.status]
                  }
                </span>
                <span>
                  {record.mode === 'mock'
                    ? '本机演示 · 无外部费用'
                    : record.usage?.costUsd === undefined
                      ? '费用未知'
                      : `估算 $${record.usage.costUsd.toFixed(6)}`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </details>
  );
}
