'use client';

import { useId, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import {
  errorMessage,
  MAX_LIBRARY_IMPORT_BYTES,
  parseLibraryImportText,
  type LibraryImportPolicy,
  type LibraryImportPreview,
  type LibraryImportResult,
} from '@productspy/shared';
import { downloadLibraryFile, exportLibrary } from '@/lib/library-api';
import { isLegacyMode, webRequest } from '@/lib/session';
import { Button, ErrorNotice } from './ui';
import { LibraryDialog } from './library-dialog';
import { libraryCopy as copy } from './library-copy';

export function LibraryTransferDialog({
  mutate,
  onClose,
}: {
  mutate: <T>(operation: () => Promise<T>) => Promise<T>;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File>();
  const fileInput = useRef<HTMLInputElement>(null);
  const fileInputId = useId();
  const [preview, setPreview] = useState<LibraryImportPreview>();
  const [policy, setPolicy] = useState<LibraryImportPolicy>('skip');
  const [stage, setStage] = useState<
    'idle' | 'reading' | 'validating' | 'committing' | 'exporting'
  >('idle');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string>();
  const data = useRef<unknown>(undefined);
  const generation = useRef(0);
  const controller = useRef<AbortController>(undefined);
  const reading = stage === 'reading' || stage === 'validating';
  const committed = stage === 'committing';
  const busy = stage !== 'idle';
  function cancel() {
    ++generation.current;
    controller.current?.abort();
    data.current = undefined;
    setPreview(undefined);
    setStage('idle');
    setMessage('已取消导入，尚未修改商品库。');
    setError(undefined);
  }
  function close() {
    if (reading) cancel();
    if (!committed && stage !== 'exporting') onClose();
  }
  async function validate() {
    if (!file) return;
    const request = ++generation.current;
    setError(undefined);
    setPreview(undefined);
    setMessage('');
    data.current = undefined;
    if (file.size > MAX_LIBRARY_IMPORT_BYTES || file.size === 0) {
      setError('请选择非空 JSON 文件，大小不能超过 25 MiB。');
      return;
    }
    if (!/\.json$/i.test(file.name)) {
      setError('仅支持 .json 文件，请选择 ProductSpy JSON 导出或备份文件。');
      return;
    }
    setStage('reading');
    try {
      const text = await file.text();
      if (request !== generation.current) return;
      parseLibraryImportText(text);
      const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      setStage('validating');
      controller.current = new AbortController();
      const result = await webRequest<LibraryImportPreview>('/api/library/import', {
        method: 'POST',
        body: JSON.stringify({ action: 'preview', data: parsed }),
        signal: controller.current.signal,
      });
      if (request !== generation.current) return;
      data.current = parsed;
      setPreview(result);
    } catch (cause) {
      if (request !== generation.current) return;
      console.error('[ProductSpy] Import validation failed', cause);
      setError(errorMessage(cause));
    } finally {
      if (request === generation.current) setStage('idle');
    }
  }
  async function commit() {
    if (!preview || !data.current) return;
    setStage('committing');
    setError(undefined);
    setMessage('');
    try {
      const result = await mutate(() =>
        webRequest<LibraryImportResult>('/api/library/import', {
          method: 'POST',
          body: JSON.stringify({
            action: 'commit',
            data: data.current,
            policy,
            confirmed: true,
            expectedRevision: preview.revision,
          }),
        }),
      );
      setMessage(copy.imported(result.imported, result.skipped, result.failed));
      setPreview(undefined);
      data.current = undefined;
    } catch (cause) {
      console.error('[ProductSpy] Import commit failed', cause);
      setError(
        `${errorMessage(cause)}。请刷新商品库检查结果；重新验证文件后再导入，不要重复提交旧预览。`,
      );
      setPreview(undefined);
      data.current = undefined;
    } finally {
      setStage('idle');
    }
  }
  async function backup() {
    setStage('exporting');
    setError(undefined);
    setMessage(copy.exporting);
    try {
      const result = await exportLibrary('json');
      downloadLibraryFile(result);
      setMessage(`完整备份已下载，包含 ${result.count} 个商品。`);
    } catch (cause) {
      setError(errorMessage(cause));
      setMessage('');
    } finally {
      setStage('idle');
    }
  }
  return (
    <LibraryDialog title={copy.data} busy={committed || stage === 'exporting'} onClose={close}>
      <section className="library-transfer-backup">
        <h3>{isLegacyMode ? '备份本机商品库' : '备份账号商品库'}</h3>
        <p className="muted">{copy.backupDescription}</p>
        <Button variant="secondary" disabled={busy} onClick={() => void backup()}>
          <Download size={15} />
          {copy.backup}
        </Button>
      </section>
      <section className="library-transfer-import">
        <h3>{copy.importTitle}</h3>
        <p className="muted">{copy.importDescription}</p>
        <div className="library-file-field">
          <label htmlFor={fileInputId}>{copy.chooseFile}</label>
          <input
            id={fileInputId}
            ref={fileInput}
            aria-label={copy.chooseFile}
            hidden
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(event) => {
              ++generation.current;
              setFile(event.currentTarget.files?.[0]);
              setPreview(undefined);
              data.current = undefined;
              setError(undefined);
              setMessage('');
            }}
          />
          <div className="library-file-picker">
            <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
              {copy.pickFile}
            </Button>
            <span title={file?.name}>{file?.name ?? copy.noFile}</span>
          </div>
        </div>
        <div className="ws-inline">
          <Button variant="secondary" disabled={busy || !file} onClick={() => void validate()}>
            <Upload size={15} />
            {copy.preview}
          </Button>
          {reading && (
            <Button variant="ghost" onClick={cancel}>
              {copy.importCancel}
            </Button>
          )}
        </div>
        {busy && (
          <div
            className="library-transfer-progress"
            role="progressbar"
            aria-label="导入导出进度"
            aria-valuetext={
              stage === 'reading'
                ? copy.reading
                : stage === 'validating'
                  ? copy.validating
                  : stage === 'committing'
                    ? copy.committing
                    : copy.exporting
            }
          >
            <span className="library-progress-indicator" />
            {stage === 'reading'
              ? copy.reading
              : stage === 'validating'
                ? copy.validating
                : stage === 'committing'
                  ? copy.committing
                  : copy.exporting}
          </div>
        )}
        {error && <ErrorNotice message={error} />}
        {message && (
          <p className="library-operation-status" role="status">
            {message}
          </p>
        )}
        {preview && (
          <div className="library-import-preview" aria-label="导入预览">
            <p role="status">
              <strong>
                {copy.previewCounts(preview.total, preview.newProducts, preview.conflicts.length)}
              </strong>
            </p>
            <p>
              分组 {preview.groups} 个 · 标签 {preview.tags} 个
              {preview.reassignedIds > 0 ? ` · ${preview.reassignedIds} 个编号冲突将分配新 ID` : ''}
            </p>
            {preview.conflicts.length > 0 && (
              <details open>
                <summary>
                  {copy.conflicts}（{preview.conflicts.length}）
                </summary>
                <ul>
                  {preview.conflicts.slice(0, 20).map((conflict) => (
                    <li key={conflict.incomingId}>
                      <strong>{conflict.sourceId}</strong> · {conflict.title}
                    </li>
                  ))}
                </ul>
                {preview.conflicts.length > 20 && (
                  <p>
                    仅预览前 20 个冲突；全部 {preview.conflicts.length}{' '}
                    个重复商品都会按所选安全策略处理。
                  </p>
                )}
              </details>
            )}
            <label>
              <span>{copy.importPolicy}</span>
              <select
                aria-label={copy.importPolicy}
                value={policy}
                disabled={busy}
                onChange={(event) => setPolicy(event.currentTarget.value as LibraryImportPolicy)}
              >
                <option value="skip">{copy.skip}</option>
                <option value="preserve">{copy.preserve}</option>
              </select>
            </label>
            <p className="muted">{copy.preserveNote}</p>
            <p className="muted">
              {copy.beforeConfirm} {copy.commitNote}
            </p>
            <div className="ws-inline">
              <Button disabled={busy} onClick={() => void commit()}>
                {copy.confirmImport}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={cancel}>
                {copy.importCancel}
              </Button>
            </div>
          </div>
        )}
      </section>
      <p className="library-transfer-privacy muted">{copy.safeBackup}</p>
      <div className="library-dialog-footer">
        <Button variant="secondary" disabled={committed || stage === 'exporting'} onClick={close}>
          {copy.close}
        </Button>
      </div>
    </LibraryDialog>
  );
}
