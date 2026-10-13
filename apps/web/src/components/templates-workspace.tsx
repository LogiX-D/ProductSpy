'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Copy, Download, History, Plus, Star, Trash2, Upload } from 'lucide-react';
import {
  templateDefinition,
  templateBackupSchema,
  MAX_TEMPLATE_BACKUP_BYTES,
  errorMessage,
  type AITemplate,
  type Product,
  type TemplateDefinition,
  type TemplateBackup,
} from '@productspy/shared';
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  backupTemplates,
  importTemplates,
  type TemplateImportPreview,
} from '../lib/templates-api';
import { productRepository } from '../lib/storage/product-api';
import { downloadLibraryFile } from '../lib/library-api';
import { TemplateEditor, emptyTemplateDefinition } from './template-editor';
import { singleTemplateBackup } from './template-export';
import { LibraryDialog } from './library-dialog';
import { Badge, Button, EmptyState, ErrorNotice, LoadingState, PageHeading } from './ui';
import './library.css';
import './content-workspace.css';

export function TemplatesWorkspace() {
  const [templates, setTemplates] = useState<AITemplate[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [favorites, setFavorites] = useState(false);
  const [builtinFavorites, setBuiltinFavorites] = useState<string[]>([]);
  const [editor, setEditor] = useState<{
    template?: AITemplate;
    definition: TemplateDefinition;
    title: string;
  }>();
  const [history, setHistory] = useState<AITemplate>();
  const [deleting, setDeleting] = useState<AITemplate>();
  const [importing, setImporting] = useState<{
    backup: TemplateBackup;
    preview: TemplateImportPreview;
  }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const categories = [...new Set(templates.map((template) => template.category))].sort();
  const filtered = useMemo(
    () =>
      templates.filter(
        (template) =>
          (!category || template.category === category) &&
          (!favorites || template.favorite || builtinFavorites.includes(template.id)) &&
          `${template.name} ${template.description} ${template.scenario} ${template.tags.join(' ')}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
      ),
    [templates, category, favorites, query, builtinFavorites],
  );
  async function load() {
    setLoading(true);
    setError('');
    try {
      const [fresh, savedProducts] = await Promise.all([listTemplates(), productRepository.list()]);
      setTemplates(fresh);
      setProducts(savedProducts);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    try {
      const raw = localStorage.getItem('productspy:builtin-template-favorites:v1');
      if (raw && raw.length < 16000) {
        const value: unknown = JSON.parse(raw);
        if (
          Array.isArray(value) &&
          value.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
        )
          setBuiltinFavorites(value.slice(0, 200));
      }
    } catch {
      setMessage('浏览器收藏存储不可用，用户模板仍可正常保存。');
    }
  }, []);
  function apply(template: AITemplate) {
    setTemplates((current) => [template, ...current.filter((item) => item.id !== template.id)]);
  }
  async function save(definition: TemplateDefinition) {
    setBusy(true);
    try {
      const value = editor?.template
        ? await updateTemplate(editor.template, { definition })
        : await createTemplate(definition);
      apply(value);
      setEditor(undefined);
      setMessage('模板已保存，历史版本保留。');
    } finally {
      setBusy(false);
    }
  }
  async function action(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function exportTemplates(single?: AITemplate) {
    await action(async () => {
      const backup = single ? singleTemplateBackup(single) : await backupTemplates();
      downloadLibraryFile({
        filename: single
          ? `ProductSpy-template-${single.id}.json`
          : 'ProductSpy-templates-backup.json',
        mimeType: 'application/json',
        content: JSON.stringify(backup, null, 2),
        count: backup.templates.length,
      });
      setMessage(
        single
          ? '模板已导出；内置模板导入后成为独立用户模板。'
          : '用户模板与历史版本已备份；内置模板由程序提供。',
      );
    });
  }
  async function readImport(file?: File) {
    if (!file) return;
    await action(async () => {
      if (!file.name.toLowerCase().endsWith('.json') || file.size > MAX_TEMPLATE_BACKUP_BYTES)
        throw new Error('请选择不超过 25 MiB 的模板 JSON 备份。');
      const backup = templateBackupSchema.parse(JSON.parse(await file.text()));
      setImporting({ backup, preview: await importTemplates(backup) });
    });
    if (fileRef.current) fileRef.current.value = '';
  }
  if (loading) return <LoadingState />;
  return (
    <div className="ws-page">
      <PageHeading
        title="AI 模板"
        description="用可复用的内容指令规划创作；模板不会执行代码，也不能覆盖商品事实与安全规则。"
        action={
          <div className="creation-actions">
            <Button variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload size={15} />
              导入
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void exportTemplates()}>
              <Download size={15} />
              备份模板
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                setEditor({ definition: emptyTemplateDefinition, title: '创建 AI 模板' })
              }
            >
              <Plus size={16} />
              创建模板
            </Button>
          </div>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => void readImport(event.currentTarget.files?.[0])}
      />
      {error && <ErrorNotice message={error} onRetry={() => void load()} />}
      {message && (
        <p className="creation-notice" role="status">
          {message}
        </p>
      )}
      <div className="template-toolbar">
        <label className="creation-field">
          搜索
          <input
            aria-label="搜索模板"
            placeholder="名称、描述、场景或标签"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="creation-field">
          分类
          <select
            aria-label="筛选模板分类"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">全部分类</option>
            {categories.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="creation-checks">
          <input
            type="checkbox"
            checked={favorites}
            onChange={(event) => setFavorites(event.target.checked)}
          />
          只看收藏
        </label>
      </div>
      {!filtered.length ? (
        <EmptyState
          title="没有符合条件的模板"
          description="调整搜索条件，或创建一个适合你的营销内容模板。"
        />
      ) : (
        <div className="template-grid">
          {filtered.map((template) => (
            <article className="template-card" key={template.id}>
              <div className="creation-panel-heading">
                <Badge>{template.origin === 'builtin' ? '内置模板' : '用户模板'}</Badge>
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-label={`${template.favorite || builtinFavorites.includes(template.id) ? '取消收藏' : '收藏'} ${template.name}`}
                  onClick={() => {
                    if (template.origin === 'builtin') {
                      const ids = builtinFavorites.includes(template.id)
                        ? builtinFavorites.filter((id) => id !== template.id)
                        : [...builtinFavorites, template.id];
                      setBuiltinFavorites(ids);
                      try {
                        localStorage.setItem(
                          'productspy:builtin-template-favorites:v1',
                          JSON.stringify(ids),
                        );
                        setMessage('内置模板收藏仅保存在当前浏览器；用户模板收藏随备份保存。');
                      } catch {
                        setError('浏览器收藏存储不可用。');
                      }
                    } else
                      void action(async () =>
                        apply(await updateTemplate(template, { favorite: !template.favorite })),
                      );
                  }}
                >
                  <Star
                    size={15}
                    fill={
                      template.favorite || builtinFavorites.includes(template.id)
                        ? 'currentColor'
                        : 'none'
                    }
                  />
                </Button>
              </div>
              <h2>{template.name}</h2>
              <p>{template.description || '暂无描述'}</p>
              <p>
                {template.scenario || '自定义场景'} · {template.category}
              </p>
              <div className="creation-checks">
                {template.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
              <div className="creation-actions">
                <Link
                  className="button button-primary"
                  href={`/content?template=${encodeURIComponent(template.id)}`}
                >
                  用于创作
                </Link>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    setEditor({
                      ...(template.origin === 'custom' ? { template } : {}),
                      definition: {
                        ...templateDefinition(template),
                        ...(template.origin === 'builtin'
                          ? { name: `${template.name}（副本）` }
                          : {}),
                      },
                      title: template.origin === 'builtin' ? '复制内置模板' : '编辑模板',
                    })
                  }
                >
                  {template.origin === 'builtin' ? '自定义副本' : '编辑'}
                </Button>
              </div>
              <div className="creation-actions">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setEditor({
                      definition: {
                        ...templateDefinition(template),
                        name: `${template.name}（副本）`,
                      },
                      title: '复制模板',
                    })
                  }
                >
                  <Copy size={13} />
                  复制
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void exportTemplates(template)}
                >
                  <Download size={13} />
                  导出
                </Button>
                {template.origin === 'custom' && (
                  <>
                    <Button variant="ghost" disabled={busy} onClick={() => setHistory(template)}>
                      <History size={13} />
                      历史
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      aria-label={`删除 ${template.name}`}
                      onClick={() => setDeleting(template)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {editor && (
        <TemplateEditor
          initial={editor.definition}
          title={editor.title}
          products={products}
          busy={busy}
          onClose={() => setEditor(undefined)}
          onSave={save}
        />
      )}
      {deleting && (
        <LibraryDialog title="确认删除模板" busy={busy} onClose={() => setDeleting(undefined)}>
          <p className="creation-note">
            删除「{deleting.name}」及其模板历史。既有内容方案使用独立模板快照，仍会保留。
          </p>
          <div className="creation-actions" style={{ marginTop: 18 }}>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await deleteTemplate(deleting);
                  setTemplates((current) => current.filter((item) => item.id !== deleting.id));
                  setDeleting(undefined);
                  setMessage('模板已删除，既有内容方案未受影响。');
                })
              }
            >
              确认删除模板
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setDeleting(undefined)}>
              取消
            </Button>
          </div>
        </LibraryDialog>
      )}
      {history && (
        <LibraryDialog
          title={`模板历史 · ${history.name}`}
          busy={busy}
          onClose={() => setHistory(undefined)}
        >
          <p className="creation-note">恢复会增加新版本，原历史保留。</p>
          <div className="creation-versions">
            {[...history.versions].reverse().map((version) => (
              <div className="creation-version" key={version.id}>
                <div>
                  <strong>{version.snapshot.name}</strong>
                  <small>{new Date(version.createdAt).toLocaleString('zh-CN')}</small>
                </div>
                <p className="creation-note">{version.snapshot.description}</p>
                <details>
                  <summary>查看 Prompt</summary>
                  <pre className="template-preview">{version.snapshot.prompt}</pre>
                </details>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('恢复该模板版本？将保留所有历史版本。'))
                      void action(async () => {
                        const value = await updateTemplate(history, {
                          restoreVersionId: version.id,
                        });
                        apply(value);
                        setHistory(value);
                        setMessage('历史模板已恢复为新版本。');
                      });
                  }}
                >
                  恢复此版本
                </Button>
              </div>
            ))}
          </div>
        </LibraryDialog>
      )}
      {importing && (
        <LibraryDialog title="确认导入模板" busy={busy} onClose={() => setImporting(undefined)}>
          <p>
            将导入 {importing.preview.imported} 个模板，跳过 {importing.preview.skipped}{' '}
            个已有编号。
          </p>
          <p className="creation-note">
            冲突资料及原有历史不会被覆盖。导入前已验证格式、变量和数据结构。
          </p>
          {importing.preview.conflicts.map((item) => (
            <p key={item.id} className="creation-note">
              保留已有：{item.name}
            </p>
          ))}
          <div className="creation-actions" style={{ marginTop: 18 }}>
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = await importTemplates(
                    importing.backup,
                    importing.preview.revision,
                  );
                  setImporting(undefined);
                  setTemplates(await listTemplates());
                  setMessage(`导入成功 ${result.imported} 个；跳过 ${result.skipped} 个。`);
                })
              }
            >
              确认导入并保留冲突资料
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setImporting(undefined)}>
              取消
            </Button>
          </div>
        </LibraryDialog>
      )}
    </div>
  );
}
