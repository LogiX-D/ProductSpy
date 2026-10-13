'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { errorMessage, type ContentPlan, type ContentReferenceStatus } from '@productspy/shared';
import { getContentReferences } from '../lib/content-api';
import { Button, ErrorNotice } from './ui';
import { LibraryDialog } from './library-dialog';
import './integration.css';

const statusText = {
  unchanged: '与保存时一致',
  updated: '源资料已更新，本方案仍使用原快照',
  deleted: '来源已删除，本方案快照和历史仍保留',
  'identity-mismatch': '商品身份不一致，已阻止引用替换',
  'not-referenced': '保存时没有商品分析',
} as const;

export function ContentReferences({
  plan,
  disabled,
  onRenew,
}: {
  plan: ContentPlan;
  disabled: boolean;
  onRenew: (plan: ContentPlan) => Promise<void>;
}) {
  const [references, setReferences] = useState<ContentReferenceStatus>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void getContentReferences(plan.id)
      .then((result) => {
        if (active) {
          setReferences(result);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const focus = () => setRefresh((value) => value + 1);
    window.addEventListener('focus', focus);
    return () => {
      active = false;
      window.removeEventListener('focus', focus);
    };
  }, [plan.id, plan.updatedAt, refresh]);
  const changed =
    references &&
    [
      references.product,
      references.productAnalysis,
      references.template,
      references.comparison,
    ].some((value) => value && !['unchanged', 'not-referenced'].includes(value.status));
  return (
    <section className="integration-references" aria-label="内容来源与更新状态">
      <div className="creation-panel-heading">
        <h3>来源与更新状态</h3>
        <Button
          variant="ghost"
          disabled={loading || disabled}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {loading ? '正在核对来源…' : '核对来源'}
        </Button>
      </div>
      {error && (
        <ErrorNotice
          message={`来源状态暂时无法核对：${error}。已保存快照仍可查看。`}
          onRetry={() => setRefresh((value) => value + 1)}
        />
      )}
      {references && (
        <ul className="integration-source-list">
          {(
            [
              ['商品资料', references.product],
              ['商品分析', references.productAnalysis],
              ['AI 模板', references.template],
              ['竞品结论', references.comparison],
            ] as const
          )
            .filter((entry) => Boolean(entry[1]))
            .map(
              ([label, value]) =>
                value && (
                  <li key={label}>
                    <strong>{label}</strong>
                    <span>{statusText[value.status]}</span>
                  </li>
                ),
            )}
        </ul>
      )}
      {changed && (
        <p role="status" className="creation-notice">
          来源发生变化。继续生成时会引用本方案保存的原资料，不会覆盖人工编辑或自动替换历史来源。
        </p>
      )}
      <div className="creation-actions">
        {references?.product.status !== 'deleted' &&
          references?.product.status !== 'identity-mismatch' &&
          references && (
            <Link className="ws-text-link" href={`/products/${encodeURIComponent(plan.productId)}`}>
              打开商品资料 · {plan.productSnapshot.sourceId}
            </Link>
          )}
        {references && ['unchanged', 'updated'].includes(references.product.status) && (
          <Link
            className="ws-text-link"
            href={`/products/${encodeURIComponent(plan.productId)}?tab=media`}
          >
            查看商品素材
          </Link>
        )}
        {references?.comparison &&
          ['unchanged', 'updated'].includes(references.comparison.status) &&
          plan.comparisonSource && (
            <Link
              className="ws-text-link"
              href={`/comparisons?plan=${encodeURIComponent(plan.comparisonSource.id)}`}
            >
              打开竞品来源
            </Link>
          )}
        {references?.canCreateLatest && (
          <Button
            variant="secondary"
            disabled={disabled || loading}
            onClick={() => setConfirm(true)}
          >
            用最新资料创建新方案
          </Button>
        )}
      </div>
      <details className="integration-snapshot">
        <summary>查看保存的来源快照</summary>
        <p>
          {plan.productSnapshot.title} · ASIN {plan.productSnapshot.sourceId}
        </p>
        <p>
          页面来源：
          <a href={plan.productSnapshot.url} target="_blank" rel="noreferrer">
            {plan.productSnapshot.url}
          </a>
        </p>
        <p>
          页面价格：{plan.productSnapshot.price ?? '未知'}{' '}
          {plan.productSnapshot.currency ?? '币种未知'}；模板：{plan.templateSnapshot.name}
        </p>
        <p>
          商品分析：{plan.productSnapshot.aiAnalysis?.summary ?? '保存时没有分析'}（已有分析 /
          人工编辑，需核实）
        </p>
        {plan.comparisonSource && (
          <p>
            竞品快照：{plan.comparisonSource.name} ·{' '}
            {plan.comparisonSource.products.map((product) => product.sourceId).join('、')}
            ；结论属于已有 AI 推断 / 人工编辑。
          </p>
        )}
      </details>
      {confirm && (
        <LibraryDialog
          title="用最新资料准备新方案"
          busy={disabled}
          onClose={() => setConfirm(false)}
        >
          <p>
            重新载入商品、模板和仍存在的竞品结论，沿用本方案参数。旧方案、快照、人工编辑及所有历史保持独立保存。
          </p>
          <p className="creation-note">
            下一步可检查新方案资料，再点击「创建方案」。此操作不调用 AI。
          </p>
          <div className="creation-actions">
            <Button
              disabled={disabled}
              onClick={() => {
                setConfirm(false);
                void onRenew(plan);
              }}
            >
              载入最新资料
            </Button>
            <Button variant="secondary" disabled={disabled} onClick={() => setConfirm(false)}>
              取消
            </Button>
          </div>
        </LibraryDialog>
      )}
    </section>
  );
}
