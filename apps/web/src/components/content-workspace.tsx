'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Download, Plus, Star, Trash2, Upload } from 'lucide-react';
import {
  DEFAULT_CONTENT_OPTIONS,
  contentOptionsSchema,
  contentBackupSchema,
  MAX_CONTENT_BACKUP_BYTES,
  errorMessage,
  type AITemplate,
  type ContentOptions,
  type ContentPlan,
  type ComparisonPlan,
  type Product,
} from '@productspy/shared';
import {
  listContentPlans,
  createContentPlan,
  deleteContentPlan,
  updateContentPlan,
  backupContentPlans,
  importContentPlans,
  type ContentBackup,
  type ContentImportPreview,
} from '../lib/content-api';
import { listTemplates } from '../lib/templates-api';
import { listComparisons } from '../lib/comparison-api';
import { productRepository } from '../lib/storage/product-api';
import { downloadLibraryFile } from '../lib/library-api';
import { ContentPlanPanel } from './content-plan-panel';
import { CONTENT_PREFERENCES_KEY, restoreContentPreferences } from './content-preferences';
import { ContentOptionsPanel } from './content-options';
import { LibraryDialog } from './library-dialog';
import { Button, EmptyState, ErrorNotice, LoadingState, PageHeading } from './ui';
import { ANALYSIS_PREFERENCES_KEY, type AnalysisPricingPreference } from './analysis-preferences';
import './library.css';
import './content-workspace.css';

export const contentStatusLabels = {
  draft: '草稿',
  'needs-edit': '待修改',
  completed: '已完成',
} as const;

export function ContentWorkspace() {
  const [products, setProducts] = useState<Product[]>([]);
  const [templates, setTemplates] = useState<AITemplate[]>([]);
  const [comparisons, setComparisons] = useState<ComparisonPlan[]>([]);
  const [plans, setPlans] = useState<ContentPlan[]>([]);
  const [plan, setPlan] = useState<ContentPlan>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [childBusy, setChildBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [productId, setProductId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [comparisonId, setComparisonId] = useState('');
  const [name, setName] = useState('新的营销内容方案');
  const [options, setOptions] = useState<ContentOptions>({ ...DEFAULT_CONTENT_OPTIONS });
  const [pricing, setPricing] = useState<AnalysisPricingPreference>({});
  const [preferenceMessage, setPreferenceMessage] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [favorites, setFavorites] = useState(false);
  const [deleting, setDeleting] = useState<ContentPlan>();
  const [importing, setImporting] = useState<{
    backup: ContentBackup;
    preview: ContentImportPreview;
  }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(
    () =>
      plans.filter(
        (item) =>
          (!status || item.status === status) &&
          (!favorites || item.favorite) &&
          `${item.name} ${item.productSnapshot.title} ${item.productSnapshot.sourceId} ${item.templateSnapshot.name}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
      ),
    [plans, status, favorites, query],
  );
  async function load() {
    setLoading(true);
    setError('');
    try {
      const [savedProducts, savedTemplates, savedPlans, savedComparisons] = await Promise.all([
        productRepository.list(),
        listTemplates(),
        listContentPlans(),
        listComparisons(),
      ]);
      setProducts(savedProducts);
      setTemplates(savedTemplates);
      setPlans(savedPlans);
      setComparisons(savedComparisons);
      const params = new URLSearchParams(window.location.search);
      const requestedProduct = params.get('product');
      const requestedTemplate = params.get('template');
      const selectedProduct = requestedProduct
        ? savedProducts.find((item) => item.id === requestedProduct)
        : savedProducts[0];
      const selectedTemplate = requestedTemplate
        ? savedTemplates.find((item) => item.id === requestedTemplate)
        : savedTemplates[0];
      setProductId(selectedProduct?.id ?? '');
      setTemplateId(selectedTemplate?.id ?? '');
      const requestedComparison = params.get('comparison');
      const selectedComparison = savedComparisons.find(
        (item) =>
          item.id === requestedComparison &&
          item.analysis &&
          item.products.some(
            (product) =>
              product.id === selectedProduct?.id &&
              product.sourceId === selectedProduct.sourceId &&
              product.source === selectedProduct.source,
          ),
      );
      setComparisonId(selectedComparison?.id ?? '');
      if ((requestedProduct && !selectedProduct) || (requestedTemplate && !selectedTemplate))
        setMessage('入口指定的商品或模板已删除。请选择仍在库中的资料；不会自动替换为其他商品。');
      else if (requestedComparison && !selectedComparison)
        setMessage('所选竞品结论已删除、尚未分析或与商品身份不符，未添加该引用。');
      const existing = savedPlans.find((item) => item.id === params.get('plan'));
      if (existing) setPlan(existing);
      else if (
        params.has('product') ||
        params.has('template') ||
        params.has('comparison') ||
        !savedPlans.length
      )
        setCreating(true);
      else setPlan(savedPlans[0]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    try {
      const saved = restoreContentPreferences(
        localStorage.getItem(CONTENT_PREFERENCES_KEY),
        localStorage.getItem(ANALYSIS_PREFERENCES_KEY),
      );
      setOptions(saved.options);
      setPricing(saved.pricing);
    } catch {
      setPreferenceMessage('浏览器偏好存储不可用，本次设置仍可使用。');
    }
  }, []);
  function selectPlan(value: ContentPlan) {
    if (childBusy) return;
    if (
      editing &&
      !window.confirm(
        '尚有未保存更改，确定切换吗？人工编辑草稿会保留在本浏览器，未保存素材选择将放弃。',
      )
    )
      return;
    setPlan(value);
    setCreating(false);
    setEditing(false);
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('plan', value.id);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }
  function apply(value: ContentPlan) {
    setPlan((current) => (!current || current.id === value.id ? value : current));
    setPlans((current) => [value, ...current.filter((item) => item.id !== value.id)]);
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
  async function create() {
    await action(async () => {
      const safe = contentOptionsSchema.parse(options);
      const value = await createContentPlan({
        name,
        productId,
        templateId,
        options: safe,
        ...(comparisonId ? { comparisonId } : {}),
      });
      apply(value);
      selectPlan(value);
      setMessage('方案已保存。点击生成后才会请求 AI；再次生成会保留现有版本。');
    });
  }
  async function prepareLatest(source: ContentPlan) {
    await action(async () => {
      const [freshProducts, freshTemplates, freshComparisons] = await Promise.all([
        productRepository.list(),
        listTemplates(),
        listComparisons(),
      ]);
      const product = freshProducts.find(
        (item) =>
          item.id === source.productId &&
          item.sourceId === source.productSnapshot.sourceId &&
          item.source === source.productSnapshot.source,
      );
      const template = freshTemplates.find((item) => item.id === source.templateSnapshot.id);
      if (!product || !template)
        throw new Error('原商品或模板已删除，无法用最新资料建立新方案。旧方案快照仍保留。');
      const comparison = freshComparisons.find(
        (item) =>
          item.id === source.comparisonSource?.id &&
          item.analysis &&
          item.products.some(
            (value) =>
              value.id === product.id &&
              value.sourceId === product.sourceId &&
              value.source === product.source,
          ),
      );
      setProducts(freshProducts);
      setTemplates(freshTemplates);
      setComparisons(freshComparisons);
      setProductId(product.id);
      setTemplateId(template.id);
      setComparisonId(comparison?.id ?? '');
      setOptions(source.options);
      setName(`${source.name.slice(0, 110)}（最新资料）`);
      setCreating(true);
      setEditing(false);
      setMessage('最新资料已载入，请检查后创建新方案。旧方案及人工编辑保持不变；尚未调用 AI。');
    });
  }
  async function readImport(file?: File) {
    if (!file) return;
    await action(async () => {
      if (!file.name.toLowerCase().endsWith('.json') || file.size > MAX_CONTENT_BACKUP_BYTES)
        throw new Error('请选择不超过 25 MiB 的内容 JSON 备份。');
      const backup = contentBackupSchema.parse(JSON.parse(await file.text()));
      setImporting({ backup, preview: await importContentPlans(backup) });
    });
    if (fileRef.current) fileRef.current.value = '';
  }
  if (loading) return <LoadingState />;
  return (
    <div className="ws-page">
      <PageHeading
        title="内容创作"
        description="选择商品和模板，生成可编辑的文案、脚本与提示词。每份方案独立保存，商品原始资料不受影响。"
        action={
          <div className="creation-actions">
            <Button
              variant="secondary"
              disabled={busy || editing || childBusy}
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={14} />
              恢复备份
            </Button>
            <Button
              variant="secondary"
              disabled={busy || childBusy}
              onClick={() =>
                void action(async () => {
                  const backup = await backupContentPlans();
                  downloadLibraryFile({
                    filename: 'ProductSpy-content-backup.json',
                    mimeType: 'application/json',
                    content: JSON.stringify(backup, null, 2),
                    count: backup.plans.length,
                  });
                  setMessage('完整内容方案和历史已备份。');
                })
              }
            >
              <Download size={14} />
              备份方案
            </Button>
            <Button
              disabled={busy || childBusy}
              onClick={() => {
                if (
                  !editing ||
                  window.confirm(
                    '人工编辑草稿会保留在本浏览器，未保存素材选择将放弃。确定创建新方案吗？',
                  )
                ) {
                  setCreating(true);
                  setEditing(false);
                }
              }}
            >
              <Plus size={15} />
              新建方案
            </Button>
          </div>
        }
      />
      <input
        type="file"
        ref={fileRef}
        hidden
        accept=".json,application/json"
        onChange={(event) => void readImport(event.currentTarget.files?.[0])}
      />
      {error && <ErrorNotice message={error} onRetry={() => void load()} />}
      {message && (
        <p role="status" className="creation-notice">
          {message}
        </p>
      )}
      <div className="creation-layout">
        <aside className="creation-sidebar" aria-label="已保存内容方案">
          <label className="creation-field">
            搜索方案
            <input
              aria-label="搜索内容方案"
              value={query}
              placeholder="商品、ASIN、模板或方案名"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="creation-field">
            状态
            <select
              aria-label="筛选内容状态"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">全部状态</option>
              {Object.entries(contentStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
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
          <div className="creation-sidebar-list">
            {filtered.map((item) => (
              <button
                type="button"
                className="creation-plan-button"
                key={item.id}
                aria-pressed={!creating && plan?.id === item.id}
                disabled={busy || childBusy}
                onClick={() => selectPlan(item)}
              >
                <strong>
                  {item.favorite ? '★ ' : ''}
                  {item.name}
                </strong>
                <small>
                  {item.productSnapshot.sourceId} · {contentStatusLabels[item.status]}
                </small>
                <small>
                  {item.templateSnapshot.name} · {item.versions.length} 个版本
                </small>
              </button>
            ))}
          </div>
          {!filtered.length && <p className="creation-note">没有符合条件的方案。</p>}
        </aside>
        <div className="creation-main">
          {creating ? (
            <section className="creation-panel">
              <div className="creation-panel-heading">
                <h2>新建内容方案</h2>
                {plan && (
                  <Button variant="ghost" onClick={() => setCreating(false)}>
                    返回当前方案
                  </Button>
                )}
              </div>
              {!products.length ? (
                <EmptyState
                  title="先采集一个 Amazon 商品"
                  description="通过 ProductSpy 扩展保存商品后，即可选择模板生成内容。"
                  action={
                    <Link className="button button-secondary" href="/products">
                      打开商品库
                    </Link>
                  }
                />
              ) : (
                <>
                  <div className="creation-fields">
                    <label className="creation-field creation-field-wide">
                      方案名称
                      <input
                        aria-label="方案名称"
                        maxLength={120}
                        value={name}
                        disabled={busy || childBusy}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                    <label className="creation-field creation-field-wide">
                      商品
                      <select
                        aria-label="创作商品"
                        value={productId}
                        disabled={busy || childBusy}
                        onChange={(event) => {
                          setProductId(event.target.value);
                          setComparisonId('');
                        }}
                      >
                        {!productId && <option value="">请选择商品</option>}
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.title} · {product.sourceId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="creation-field creation-field-wide">
                      AI 模板
                      <select
                        aria-label="创作模板"
                        value={templateId}
                        disabled={busy || childBusy}
                        onChange={(event) => setTemplateId(event.target.value)}
                      >
                        {!templateId && <option value="">请选择模板</option>}
                        {templates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name} · {template.origin === 'builtin' ? '内置' : '自定义'}
                          </option>
                        ))}
                      </select>
                      <small>{templates.find((item) => item.id === templateId)?.description}</small>
                    </label>
                    <label className="creation-field creation-field-wide">
                      引用已保存竞品分析（可选）
                      <select
                        aria-label="引用竞品分析"
                        value={comparisonId}
                        disabled={busy || childBusy}
                        onChange={(event) => setComparisonId(event.target.value)}
                      >
                        <option value="">不引用</option>
                        {comparisons
                          .filter(
                            (item) =>
                              item.analysis &&
                              item.products.some((product) => product.id === productId),
                          )
                          .map((comparison) => (
                            <option key={comparison.id} value={comparison.id}>
                              {comparison.name} ·{' '}
                              {new Date(comparison.updatedAt).toLocaleDateString('zh-CN')}
                            </option>
                          ))}
                      </select>
                      <small>
                        只引用包含当前商品、有已保存分析和来源快照的结论；AI 推断仍需验证。
                      </small>
                    </label>
                  </div>
                  <div style={{ marginTop: 18 }}>
                    <ContentOptionsPanel
                      options={options}
                      pricing={pricing}
                      disabled={busy || childBusy}
                      message={preferenceMessage}
                      onChange={setOptions}
                      onPricing={setPricing}
                      onSave={() => {
                        try {
                          localStorage.setItem(
                            CONTENT_PREFERENCES_KEY,
                            JSON.stringify({
                              version: 1,
                              options: contentOptionsSchema.parse(options),
                              pricing,
                            }),
                          );
                          setPreferenceMessage('创作偏好已保存到本浏览器。');
                        } catch {
                          setPreferenceMessage('设置无效或存储不可用，请检查视频时长。');
                        }
                      }}
                    />
                  </div>
                  <div className="creation-actions" style={{ marginTop: 20 }}>
                    <Button
                      disabled={busy || !name.trim() || !productId || !templateId}
                      onClick={() => void create()}
                    >
                      {busy ? '正在保存…' : '创建方案'}
                    </Button>
                    <Link className="ws-text-link" href="/templates">
                      管理 AI 模板
                    </Link>
                  </div>
                  <p className="creation-note">
                    创建方案不调用付费模型。商品、模板与对比来源保存为独立快照。
                    {products.find((item) => item.id === productId)?.aiAnalysis
                      ? '已保存商品分析将作为带来源的既有推断引用，不能替代页面事实。'
                      : '此商品尚无分析，可直接创作，或先在商品详情完成分析。'}
                  </p>
                </>
              )}
            </section>
          ) : plan ? (
            <>
              <div className="creation-actions">
                <Button
                  variant="ghost"
                  disabled={busy || editing || childBusy}
                  aria-label={plan.favorite ? '取消收藏方案' : '收藏方案'}
                  onClick={() =>
                    void action(async () =>
                      apply(await updateContentPlan(plan, { favorite: !plan.favorite })),
                    )
                  }
                >
                  <Star size={15} fill={plan.favorite ? 'currentColor' : 'none'} />
                  {plan.favorite ? '已收藏' : '收藏方案'}
                </Button>
                <label className="creation-field" style={{ maxWidth: 180 }}>
                  <span className="sr-only">方案状态</span>
                  <select
                    aria-label="方案状态"
                    disabled={busy || editing || childBusy}
                    value={plan.status}
                    onChange={(event) =>
                      void action(async () =>
                        apply(
                          await updateContentPlan(plan, {
                            status: event.target.value as ContentPlan['status'],
                          }),
                        ),
                      )
                    }
                  >
                    {Object.entries(contentStatusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="ghost"
                  disabled={busy || editing || childBusy}
                  onClick={() => setDeleting(plan)}
                >
                  <Trash2 size={14} />
                  删除方案
                </Button>
              </div>
              <ContentPlanPanel
                key={plan.id}
                plan={plan}
                onUpdate={apply}
                onEditing={setEditing}
                onBusy={setChildBusy}
                onRenew={prepareLatest}
              />
            </>
          ) : (
            <EmptyState
              title="还没有内容方案"
              description="从商品和内置模板开始，创建第一份可保存的内容方案。"
            />
          )}
        </div>
      </div>
      {deleting && (
        <LibraryDialog title="确认删除内容方案" busy={busy} onClose={() => setDeleting(undefined)}>
          <p>删除「{deleting.name}」及其全部内容历史？商品资料和 AI 商品分析仍会保留。</p>
          <div className="creation-actions">
            <Button
              variant="danger"
              disabled={busy || childBusy}
              onClick={() =>
                void action(async () => {
                  await deleteContentPlan(deleting);
                  setPlans((current) => current.filter((item) => item.id !== deleting.id));
                  setPlan(undefined);
                  setDeleting(undefined);
                  setMessage('内容方案已删除。');
                })
              }
            >
              确认删除方案
            </Button>
            <Button
              variant="secondary"
              disabled={busy || childBusy}
              onClick={() => setDeleting(undefined)}
            >
              取消
            </Button>
          </div>
        </LibraryDialog>
      )}
      {importing && (
        <LibraryDialog title="确认恢复内容备份" busy={busy} onClose={() => setImporting(undefined)}>
          <p>
            将导入 {importing.backup.plans.length - importing.preview.skipped} 个方案，跳过{' '}
            {importing.preview.skipped} 个已有编号。
          </p>
          <p className="creation-note">
            不会覆盖已有方案、人工编辑或历史版本。商品和模板使用备份中的独立快照。
          </p>
          {importing.preview.conflicts.map((item) => (
            <p className="creation-note" key={item.id}>
              保留已有：{item.name}
            </p>
          ))}
          <div className="creation-actions">
            <Button
              disabled={busy || childBusy}
              onClick={() =>
                void action(async () => {
                  const result = await importContentPlans(
                    importing.backup,
                    importing.preview.revision,
                  );
                  setPlans(await listContentPlans());
                  setImporting(undefined);
                  setMessage(`恢复成功 ${result.imported} 个；跳过 ${result.skipped} 个。`);
                })
              }
            >
              确认恢复并跳过冲突
            </Button>
            <Button
              variant="secondary"
              disabled={busy || childBusy}
              onClick={() => setImporting(undefined)}
            >
              取消
            </Button>
          </div>
        </LibraryDialog>
      )}
    </div>
  );
}
