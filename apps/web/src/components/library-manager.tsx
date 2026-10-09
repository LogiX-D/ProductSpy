'use client';

import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { errorMessage, type LibraryDefinition, type LibrarySnapshot } from '@productspy/shared';
import { updateLibraryDefinition } from '@/lib/library-api';
import { Button, ErrorNotice } from './ui';
import { LibraryDialog } from './library-dialog';
import { libraryCopy as copy } from './library-copy';

export function LibraryManager({
  snapshot,
  mutate,
  onClose,
}: {
  snapshot: LibrarySnapshot;
  mutate: <T>(operation: () => Promise<T>) => Promise<T>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'group' | 'tag'>('group');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#287f74');
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<LibraryDefinition>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState('');
  const definitions = kind === 'group' ? snapshot.groups : snapshot.tags;
  const label = kind === 'group' ? '分组' : '标签';
  function reset() {
    setEditing(undefined);
    setName('');
    setColor('#287f74');
    setDeleting(undefined);
  }
  async function save() {
    setBusy(true);
    setError(undefined);
    setMessage('');
    try {
      await mutate(() =>
        updateLibraryDefinition({
          kind,
          action: editing ? 'rename' : 'create',
          id: editing,
          name: name.trim(),
          color,
        }),
      );
      reset();
      setMessage(`${label}已${editing ? '修改' : '创建'}。`);
    } catch (cause) {
      console.error('[ProductSpy] Definition save failed', cause);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(undefined);
    setMessage('');
    try {
      await mutate(() =>
        updateLibraryDefinition({ kind, action: 'delete', id: deleting.id, confirmed: true }),
      );
      if (editing === deleting.id) reset();
      setDeleting(undefined);
      setMessage(`${label}已删除，商品资料仍保留。`);
    } catch (cause) {
      console.error('[ProductSpy] Definition deletion failed', cause);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <LibraryDialog title={copy.manage} busy={busy} onClose={onClose}>
      <div className="library-manager-tabs" role="group" aria-label="管理类型">
        <Button
          variant={kind === 'group' ? 'primary' : 'secondary'}
          disabled={busy}
          aria-pressed={kind === 'group'}
          onClick={() => {
            setKind('group');
            reset();
            setMessage('');
            setError(undefined);
          }}
        >
          {copy.groups}
        </Button>
        <Button
          variant={kind === 'tag' ? 'primary' : 'secondary'}
          disabled={busy}
          aria-pressed={kind === 'tag'}
          onClick={() => {
            setKind('tag');
            reset();
            setMessage('');
            setError(undefined);
          }}
        >
          {copy.tags}
        </Button>
      </div>
      <form
        className="library-definition-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          <span>{kind === 'group' ? copy.groupName : copy.tagName}</span>
          <input
            required
            maxLength={48}
            disabled={busy}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className="library-color-field">
          <span>{kind === 'group' ? copy.groupColor : copy.tagColor}</span>
          <input
            type="color"
            disabled={busy}
            value={color}
            onChange={(event) => setColor(event.currentTarget.value)}
          />
        </label>
        <Button type="submit" disabled={busy || !name.trim()}>
          <Plus size={15} />
          {editing ? copy.saveDefinition : kind === 'group' ? copy.createGroup : copy.createTag}
        </Button>
        {editing && (
          <Button variant="ghost" disabled={busy} onClick={reset}>
            {copy.cancelEdit}
          </Button>
        )}
      </form>
      {error && <ErrorNotice message={error} />}
      <p className="library-operation-status" role="status">
        {busy ? copy.applying : message}
      </p>
      {deleting && (
        <div className="library-confirmation" role="group" aria-label={`确认删除${label}`}>
          <strong>
            确认删除{label}「{deleting.name}」？
          </strong>
          <p>这会从商品中移除该{label}关联，商品、AI 分析和历史版本仍保留。</p>
          <div className="ws-inline">
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              确认删除{label}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDeleting(undefined)}>
              取消
            </Button>
          </div>
        </div>
      )}
      <div className="library-definition-list">
        {!definitions.length ? (
          <p className="muted">{kind === 'group' ? copy.noGroups : copy.noTags}</p>
        ) : (
          definitions.map((definition) => {
            const count = snapshot.products.filter((product) =>
              (kind === 'group' ? product.groupIds : product.tagIds)?.includes(definition.id),
            ).length;
            return (
              <div className="library-definition-row" key={definition.id}>
                <span
                  className="library-definition-dot"
                  style={{ backgroundColor: definition.color }}
                />
                <span className="library-definition-name">{definition.name}</span>
                <small>{copy.membershipCount(count)}</small>
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-label={`修改${label} ${definition.name}`}
                  onClick={() => {
                    setEditing(definition.id);
                    setName(definition.name);
                    setColor(definition.color);
                    setDeleting(undefined);
                  }}
                >
                  <Pencil size={15} />
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-label={`删除${label} ${definition.name}`}
                  onClick={() => {
                    setDeleting(definition);
                    setError(undefined);
                  }}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            );
          })
        )}
      </div>
      <div className="library-dialog-footer">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {copy.close}
        </Button>
      </div>
    </LibraryDialog>
  );
}
