'use client';

import { useState } from 'react';
import { Download, ListChecks, X } from 'lucide-react';
import {
  errorMessage,
  MAX_BATCH_PRODUCTS,
  type LibraryBatchRequest,
  type LibraryBatchResult,
  type LibrarySnapshot,
  type Product,
} from '@productspy/shared';
import {
  batchLibraryProducts,
  downloadLibraryFile,
  exportLibrary,
  type LibraryExportFormat,
} from '@/lib/library-api';
import { Button, ErrorNotice } from './ui';
import { LibraryDialog } from './library-dialog';
import { libraryCopy as copy } from './library-copy';

type Operation = LibraryBatchRequest['operation'];
const destructive: Operation[] = ['delete', 'move-group', 'remove-tags', 'remove-groups'];
export function LibraryBatchToolbar({
  selected,
  snapshot,
  disabled,
  mutate,
  onSuccess,
  onClear,
}: {
  selected: Product[];
  snapshot: LibrarySnapshot;
  disabled: boolean;
  mutate: <T>(operation: () => Promise<T>) => Promise<T>;
  onSuccess: (ids: string[]) => void;
  onClear: () => void;
}) {
  const [operation, setOperation] = useState<Operation>('add-tags');
  const [targets, setTargets] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<{
    request: LibraryBatchRequest;
    titles: string[];
  }>();
  const [busy, setBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState<LibraryExportFormat>('json');
  const [result, setResult] = useState<LibraryBatchResult>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState('');
  const tags = operation.includes('tags');
  const definitions = tags ? snapshot.tags : snapshot.groups;
  const canApply =
    selected.length > 0 &&
    selected.length <= MAX_BATCH_PRODUCTS &&
    (operation === 'delete' || targets.length > 0);
  const locked = disabled || busy;
  function prepareRequest(): LibraryBatchRequest {
    return {
      ids: selected.map((product) => product.id),
      operation,
      expectedUpdatedAt: Object.fromEntries(
        selected.map((product) => [product.id, product.updatedAt]),
      ),
      ...(operation === 'delete' ? {} : tags ? { tagIds: targets } : { groupIds: targets }),
      ...(destructive.includes(operation) ? { confirmed: true } : {}),
    };
  }
  async function run(prepared?: LibraryBatchRequest) {
    const request = prepared ?? prepareRequest();
    setBusy(true);
    setError(undefined);
    setMessage('');
    setResult(undefined);
    try {
      const next = await mutate(() => batchLibraryProducts(request));
      setResult(next);
      onSuccess(next.succeededIds);
      setConfirmation(undefined);
    } catch (cause) {
      console.error('[ProductSpy] Batch operation failed', cause);
      setError(`${errorMessage(cause)}。${copy.resultUnknown}`);
      setConfirmation(undefined);
    } finally {
      setBusy(false);
    }
  }
  async function exportSelected() {
    if (!selected.length) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    setMessage(copy.exporting);
    try {
      const file = await exportLibrary(
        exportFormat,
        selected.map((product) => product.id),
      );
      downloadLibraryFile(file);
      setMessage(copy.exported(file.count));
    } catch (cause) {
      setError(errorMessage(cause));
      setMessage('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="library-batch" aria-label="多选与批量操作">
      <div className="library-batch-heading">
        <span>
          <ListChecks size={17} />
          <strong>{copy.selected(selected.length)}</strong>
        </span>
        <Button variant="ghost" disabled={locked || !selected.length} onClick={onClear}>
          <X size={14} />
          {copy.clearSelection}
        </Button>
      </div>
      <div className="library-batch-actions">
        <label>
          <span>{copy.operation}</span>
          <select
            aria-label={copy.operation}
            value={operation}
            disabled={locked}
            onChange={(event) => {
              setOperation(event.currentTarget.value as Operation);
              setTargets([]);
              setResult(undefined);
            }}
          >
            {(Object.keys(copy.operationLabels) as Operation[]).map((key) => (
              <option value={key} key={key}>
                {copy.operationLabels[key]}
              </option>
            ))}
          </select>
        </label>
        {operation !== 'delete' && (
          <label className="library-batch-target">
            <span>
              {tags
                ? copy.chooseTags
                : operation === 'move-group'
                  ? copy.chooseOneGroup
                  : copy.chooseGroups}
            </span>
            <select
              aria-label={
                tags
                  ? copy.chooseTags
                  : operation === 'move-group'
                    ? copy.chooseOneGroup
                    : copy.chooseGroups
              }
              multiple={operation !== 'move-group'}
              size={
                operation === 'move-group'
                  ? undefined
                  : Math.min(3, Math.max(2, definitions.length))
              }
              value={operation === 'move-group' ? (targets[0] ?? '') : targets}
              disabled={locked || !definitions.length}
              onChange={(event) =>
                setTargets(
                  Array.from(event.currentTarget.selectedOptions)
                    .map((option) => option.value)
                    .filter(Boolean),
                )
              }
            >
              {operation === 'move-group' && <option value="">请选择目标分组</option>}
              {definitions.map((definition) => (
                <option value={definition.id} key={definition.id}>
                  {definition.name}
                </option>
              ))}
            </select>
            {!definitions.length && <small>{copy.missingDefinition}</small>}
          </label>
        )}
        <Button
          variant={operation === 'delete' ? 'danger' : 'primary'}
          disabled={locked || !canApply}
          onClick={() =>
            destructive.includes(operation)
              ? setConfirmation({
                  request: prepareRequest(),
                  titles: selected.map((product) => product.title),
                })
              : void run()
          }
        >
          {busy ? copy.applying : copy.apply}
        </Button>
        <div className="library-batch-export">
          <label>
            <span>{copy.export}</span>
            <select
              aria-label={copy.export}
              value={exportFormat}
              disabled={locked}
              onChange={(event) =>
                setExportFormat(event.currentTarget.value as LibraryExportFormat)
              }
            >
              <option value="json">{copy.json}</option>
              <option value="csv">{copy.csv}</option>
              <option value="markdown">{copy.markdown}</option>
            </select>
          </label>
          <Button
            variant="secondary"
            disabled={locked || !selected.length}
            onClick={() => void exportSelected()}
          >
            <Download size={15} />
            导出
          </Button>
        </div>
      </div>
      {error && <ErrorNotice message={error} />}
      {message && (
        <p role="status" className="library-operation-status">
          {message}
        </p>
      )}
      {result && (
        <div className="library-batch-result">
          <p role="status">{copy.success(result.succeededIds.length, result.failures.length)}</p>
          {result.failures.length > 0 && (
            <details>
              <summary>{copy.failures}</summary>
              <ul>
                {result.failures.map((failure) => (
                  <li key={failure.id}>
                    <strong>
                      {snapshot.products.find((product) => product.id === failure.id)?.title ??
                        failure.id}
                    </strong>
                    ：{failure.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {confirmation && (
        <LibraryDialog
          title={
            confirmation.request.operation === 'delete'
              ? copy.deleteTitle
              : confirmation.request.operation === 'move-group'
                ? copy.moveTitle
                : copy.removeTitle
          }
          busy={busy}
          onClose={() => setConfirmation(undefined)}
        >
          <p>
            {confirmation.request.operation === 'delete'
              ? copy.deleteDescription
              : confirmation.request.operation === 'move-group'
                ? copy.moveDescription
                : copy.removeDescription}
          </p>
          <p>
            <strong>{copy.selected(confirmation.request.ids.length)}</strong>
          </p>
          <ul className="library-confirm-products">
            {confirmation.titles.slice(0, 3).map((title, index) => (
              <li key={confirmation.request.ids[index]}>{title}</li>
            ))}
          </ul>
          {confirmation.request.ids.length > 3 && (
            <p className="muted">另有 {confirmation.request.ids.length - 3} 个商品。</p>
          )}
          <div className="library-dialog-footer">
            <Button
              variant={confirmation.request.operation === 'delete' ? 'danger' : 'primary'}
              disabled={busy}
              onClick={() => void run(confirmation.request)}
            >
              {busy ? copy.applying : copy.confirmApply}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmation(undefined)}>
              取消
            </Button>
          </div>
        </LibraryDialog>
      )}
    </section>
  );
}
