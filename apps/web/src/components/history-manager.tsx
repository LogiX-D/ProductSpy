'use client';

import { useCallback, useEffect, useState } from 'react';
import { Archive, Trash2 } from 'lucide-react';
import type { HistoryKind, HistorySummary } from '@productspy/shared';
import { archiveHistory, cleanupHistory, getHistorySummary } from '../lib/history-api';
import { Button, ErrorNotice } from './ui';

const kinds: Record<string, string> = {
  created: '初始版本',
  legacy: '旧版分析',
  generated: '生成内容',
  edited: '人工编辑',
  restored: '恢复版本',
};
const size = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;

export function HistoryManager({
  kind,
  id,
  updatedAt,
  onChanged,
}: {
  kind: HistoryKind;
  id: string;
  updatedAt: string;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<HistorySummary>();
  const [selected, setSelected] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const load = useCallback(async () => {
    setError(undefined);
    try {
      setSummary(await getHistorySummary(kind, id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '历史资料暂时无法读取，请重试。');
    }
  }, [kind, id]);
  useEffect(() => {
    setSelected([]);
    setReceipt(undefined);
    setConfirmed(false);
    if (open) void load();
  }, [updatedAt, open, load]);
  // A successful cleanup refreshes the parent entity's timestamp. Preserve its
  // feedback through that refresh; clear only on another entity or a new opening.
  useEffect(() => setMessage(undefined), [kind, id, open]);
  function toggle(versionId: string) {
    setSelected((current) =>
      current.includes(versionId)
        ? current.filter((value) => value !== versionId)
        : [...current, versionId],
    );
    setReceipt(undefined);
    setConfirmed(false);
    setMessage(undefined);
  }
  async function archive() {
    if (!summary || !selected.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await archiveHistory({
        kind,
        id,
        expectedUpdatedAt: summary.updatedAt,
        versionIds: selected,
      });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result.archive, null, 2)], {
          type: 'application/json;charset=utf-8',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `ProductSpy-history-${kind}-${id.replace(/[^a-z0-9-]/gi, '_').slice(0, 100)}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setReceipt(result.archiveReceipt);
      setMessage('已发起所选历史归档下载。请确认文件保存成功，再决定是否清理；凭证 30 分钟有效。');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '归档失败，历史没有清理。');
    } finally {
      setBusy(false);
    }
  }
  async function cleanup() {
    if (!summary || !receipt || !confirmed || !selected.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await cleanupHistory({
        kind,
        id,
        expectedUpdatedAt: summary.updatedAt,
        versionIds: selected,
        confirmed: true,
        archiveReceipt: receipt,
      });
      setSummary(result.summary);
      setSelected([]);
      setReceipt(undefined);
      setConfirmed(false);
      setMessage(`已清理 ${result.removed} 个归档版本。当前结果、初始恢复节点和恢复来源已保留。`);
      onChanged?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '清理失败，原始资料保留。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="history-manager" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        历史容量管理
        {summary ? ` · ${summary.count}/${summary.max} · ${size(summary.totalBytes)}` : ''}
      </summary>
      {open && (
        <div className="history-manager-body">
          <p className="muted">
            选择需要归档的旧版本，下载保存后再确认清理。不会自动选择或删除人工编辑。当前版本、初始恢复节点及恢复来源受保护。
          </p>
          {summary?.approachingLimit && (
            <p className="warning-notice" role="status">
              已保存 {summary.count}/50 个版本。建议先归档并整理；达到上限后不会自动删除历史或发起新
              AI 请求。
            </p>
          )}
          {error && <ErrorNotice message={error} onRetry={() => void load()} />}
          {!summary && !error && <p role="status">正在读取历史容量…</p>}
          {summary && (
            <>
              {!summary.count && (
                <p className="muted">还没有历史版本。生成或保存编辑后可在这里管理。</p>
              )}
              <fieldset className="history-manager-list" disabled={busy}>
                <legend>选择历史版本</legend>
                {summary.versions.map((version) => (
                  <label key={version.id} className="history-manager-row">
                    <input
                      type="checkbox"
                      aria-label={`归档 ${kinds[version.kind] ?? version.kind} ${version.date}`}
                      checked={selected.includes(version.id)}
                      onChange={() => toggle(version.id)}
                    />
                    <span>
                      <strong>{kinds[version.kind] ?? version.kind}</strong>
                      <br />
                      <time dateTime={version.date}>
                        {new Date(version.date).toLocaleString('zh-CN')}
                      </time>
                      <br />
                      <small>
                        {version.id.slice(0, 8)} · {size(version.bytes)}
                        {version.protected ? ` · ${version.reason}（仅归档，不可清理）` : ''}
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="history-manager-actions">
                <Button
                  variant="secondary"
                  disabled={busy || !selected.length}
                  onClick={() => void archive()}
                >
                  <Archive size={15} />
                  {busy
                    ? '处理中…'
                    : `导出所选历史${selected.length ? `（${selected.length}）` : ''}`}
                </Button>
              </div>
              {receipt && (
                <div className="history-manager-confirm">
                  <p>
                    将清理选定的 {selected.length} 个历史版本，其中人工编辑{' '}
                    {
                      summary.versions.filter(
                        (version) => selected.includes(version.id) && version.kind === 'edited',
                      ).length
                    }{' '}
                    个。归档保留完整快照；常规导入会跳过同名编号，清理后不能在此直接恢复已移出的版本。
                  </p>
                  {selected.some((versionId) =>
                    summary.versions.some(
                      (version) => version.id === versionId && version.protected,
                    ),
                  ) ? (
                    <p className="muted">
                      选择包含受保护版本，可导出归档，但不能清理。请调整选择后重新导出。
                    </p>
                  ) : (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(event) => setConfirmed(event.target.checked)}
                          disabled={busy}
                        />{' '}
                        我已确认归档文件保存成功，明确清理上述旧版本。
                      </label>
                      <Button
                        variant="danger"
                        disabled={busy || !confirmed}
                        onClick={() => void cleanup()}
                      >
                        <Trash2 size={15} />
                        确认清理所选旧版本
                      </Button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {message && <p role="status">{message}</p>}
        </div>
      )}
      <style>{`.history-manager{border-top:1px solid #e2e8f0;padding-top:16px;margin-top:20px;min-width:0}.history-manager summary{cursor:pointer;font-weight:600;line-height:1.7}.history-manager-body{padding-top:12px;min-width:0}.history-manager-list{border:0;padding:0;margin:14px 0;max-height:310px;overflow:auto}.history-manager-list legend{font-size:13px;color:#64748b;margin-bottom:8px}.history-manager-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #f1f5f9;font-size:13px;overflow-wrap:anywhere}.history-manager-row input{margin-top:4px;flex-shrink:0}.history-manager-row small{color:#64748b}.history-manager-actions{display:flex;gap:10px;flex-wrap:wrap}.history-manager-confirm{border:1px solid #fecaca;border-radius:8px;padding:12px;margin-top:12px;font-size:13px;display:grid;gap:12px}.history-manager-confirm label{display:flex;gap:8px;align-items:flex-start}.history-manager-confirm .button{justify-self:start;max-width:100%;white-space:normal}`}</style>
    </details>
  );
}
