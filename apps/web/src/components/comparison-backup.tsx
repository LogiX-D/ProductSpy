'use client';

import { useState } from 'react';
import {
  comparisonBackupSchema,
  errorMessage,
  MAX_COMPARISON_BACKUP_BYTES,
} from '@productspy/shared';
import {
  backupComparisons,
  importComparisons,
  type ComparisonBackup,
  type ComparisonImportResult,
} from '../lib/comparison-api';
import { downloadLibraryFile } from '../lib/library-api';
import { LibraryDialog } from './library-dialog';
import { Button, ErrorNotice } from './ui';

export function ComparisonBackupDialog({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [backup, setBackup] = useState<ComparisonBackup>();
  const [preview, setPreview] = useState<ComparisonImportResult>();
  async function download() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const value = await backupComparisons();
      downloadLibraryFile({
        filename: `ProductSpy-comparisons-backup-${new Date().toISOString().slice(0, 10)}.json`,
        mimeType: 'application/json;charset=utf-8',
        content: JSON.stringify(value, null, 2),
        count: value.plans.length,
      });
      setMessage(`已交给浏览器保存 ${value.plans.length} 个方案及其快照、分析和历史。`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function readFile(file: File | undefined) {
    setBackup(undefined);
    setPreview(undefined);
    setMessage('');
    setError('');
    if (!file) return;
    if (file.size === 0 || file.size > MAX_COMPARISON_BACKUP_BYTES) {
      setError('请选择非空 JSON 备份文件，最大 25 MB。');
      return;
    }
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const value = comparisonBackupSchema.parse(parsed);
      const result = await importComparisons(value);
      setBackup(value);
      setPreview(result);
    } catch (cause) {
      console.warn('[ProductSpy] Comparison import preview rejected', cause);
      setError('无法读取此备份：文件结构或资料不合法，或工作台已断开。现有方案没有被修改。');
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!backup || !preview || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await importComparisons(backup, preview.revision);
      setMessage(
        `恢复完成：新增 ${result.imported} 个方案，跳过 ${result.skipped} 个重复方案。现有快照与分析未被覆盖。`,
      );
      setBackup(undefined);
      setPreview(undefined);
      onRestored();
    } catch (cause) {
      setError(`${errorMessage(cause)}。未覆盖已有方案；如资料已经变化，请重新选择文件进行预览。`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <LibraryDialog title="对比方案备份与恢复" busy={busy} onClose={onClose}>
      <p>
        商品库备份与对比方案备份分别保存。此文件包含独立商品快照、对比分析和历史，不包含 API
        Key、配对令牌或会话资料。
      </p>
      <Button variant="secondary" disabled={busy} onClick={() => void download()}>
        {busy ? '正在处理…' : '下载完整方案备份'}
      </Button>
      <label className="library-file-field">
        <span>恢复方案 JSON（最大 25 MB）</span>
        <input
          aria-label="选择对比方案备份"
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            void readFile(file);
          }}
        />
      </label>
      {error && <ErrorNotice message={error} />}
      {message && (
        <p className="comparison-notice" role="status">
          {message}
        </p>
      )}
      {preview && (
        <div className="comparison-backup-preview">
          <p>
            已验证 {preview.total} 个方案，将新增 {preview.total - preview.skipped} 个，跳过{' '}
            {preview.skipped} 个重复方案。
          </p>
          <p className="muted">使用安全跳过策略：已有方案、快照、分析和历史不会被覆盖。</p>
          {preview.conflicts.length > 0 && (
            <details>
              <summary>查看重复方案</summary>
              <ul>
                {preview.conflicts.map((item) => (
                  <li key={item.id}>{item.name}</li>
                ))}
              </ul>
            </details>
          )}
          <Button
            disabled={busy || preview.total === preview.skipped}
            onClick={() => void restore()}
          >
            确认恢复新方案
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBackup(undefined);
              setPreview(undefined);
            }}
          >
            取消本次导入
          </Button>
        </div>
      )}
      <div className="library-dialog-footer">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          关闭
        </Button>
      </div>
    </LibraryDialog>
  );
}
