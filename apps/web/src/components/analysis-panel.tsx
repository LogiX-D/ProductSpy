'use client';
import { useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import {
  analysisSchema,
  apiRequest,
  errorMessage,
  type Product,
  type ProductAnalysis,
} from '@productspy/shared';
import { productRepository } from '../lib/storage/product-api';
import { webRequest } from '../lib/session';
import { Badge, Button, CopyButton, EmptyState, ErrorNotice } from './ui';

function Cards({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="analysis-section">
      <h2>{title}</h2>
      <div className="analysis-grid">
        {items.map((item, index) => (
          <article className="panel analysis-card" key={`${index}-${item}`}>
            <span className="analysis-card-number">{String(index + 1).padStart(2, '0')}</span>
            <p>{item}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
function InsightList({ items }: { items: string[] }) {
  return (
    <ul className="insight-list">
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}
function Prompts({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="analysis-section">
      <h2>{title}</h2>
      <div className="analysis-two">
        {items.map((item, index) => (
          <article className="panel prompt-card" key={`${index}-${item}`}>
            <p>{item}</p>
            <CopyButton value={item} />
          </article>
        ))}
      </div>
    </section>
  );
}
export function parseScript(script: string): { label: string; content: string }[] {
  const matches = [...script.matchAll(/(?:^|\n)(Hook|Problem|Solution|Demo|CTA)\s*[:：]\s*/gi)];
  return matches.map((match, index) => ({
    label: match[1],
    content: script
      .slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? script.length)
      .trim(),
  }));
}

export function AnalysisPanel({
  product,
  onUpdate,
}: {
  product: Product;
  onUpdate: (product: Product) => void;
}) {
  const [mode, setMode] = useState<'mock' | 'real'>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState<ProductAnalysis>();
  useEffect(() => {
    let active = true;
    void apiRequest<{ mode: 'mock' | 'real' }>('/api/status')
      .then((status) => {
        if (active) setMode(status.mode);
      })
      .catch((reason: unknown) => {
        console.warn('[ProductSpy] AI configuration status unavailable', reason);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    setGenerated(undefined);
  }, [product.updatedAt]);
  async function analyze() {
    setBusy(true);
    setError('');
    try {
      const data = await webRequest<unknown>('/api/analyze-product', {
        method: 'POST',
        body: JSON.stringify(product),
        signal: AbortSignal.timeout(90000),
      });
      const result = analysisSchema.parse(data);
      setGenerated(result);
      try {
        const updated = await productRepository.get(product.id);
        if (updated) onUpdate(updated);
      } catch (reason) {
        console.error('[ProductSpy] Analysis saved, refresh failed', reason);
        setError('分析已生成并保存，但页面刷新失败。请使用上方刷新按钮重新读取商品。');
      }
    } catch (reason: unknown) {
      console.error('[ProductSpy] AI analysis failed', reason);
      setError(errorMessage(reason, 'AI 分析失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  }
  const analysis = generated ?? product.aiAnalysis;
  return (
    <>
      <div className="analysis-top">
        <div>
          <div className="flex items-center gap-3">
            <h2>AI Analysis</h2>
            {mode && (
              <Badge tone={mode === 'mock' ? 'warning' : 'success'}>
                {mode === 'mock' ? 'Mock 演示模式' : 'AI 服务已配置'}
              </Badge>
            )}
          </div>
          <p>从商品资料到营销角度，把素材变成可执行的创作起点。</p>
          {mode === 'mock' && (
            <p>
              当前为 Mock 演示：无需 API Key，可体验完整流程。结果是本机模板，不会调用外部 AI 服务。
            </p>
          )}
          {mode === 'real' && <p>开始分析后，商品文字资料将发送至你配置的 AI 服务。</p>}
        </div>
        <Button onClick={() => void analyze()} disabled={busy}>
          {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
          {busy ? '正在分析…' : analysis ? '重新 AI 分析' : '开始 AI 分析'}
        </Button>
      </div>
      {error && <ErrorNotice message={error} onRetry={() => void analyze()} />}
      {!analysis ? (
        <EmptyState
          title={busy ? '正在生成商品分析' : '让商品素材开始发挥价值'}
          description={
            busy
              ? '正在整理卖点、用户动机和短视频创作方向，请稍候。'
              : '点击「开始 AI 分析」，获得卖点、用户痛点、5 条以上 Hook 和完整短视频脚本。'
          }
        />
      ) : (
        <>
          <section className="analysis-summary">
            <h2>商品总结</h2>
            <p>{analysis.summary}</p>
          </section>
          <Cards title="核心卖点" items={analysis.sellingPoints} />
          <div className="analysis-two analysis-section">
            <section className="panel content-panel">
              <h2>用户痛点</h2>
              <InsightList items={analysis.painPoints} />
            </section>
            <section className="panel content-panel">
              <h2>目标用户</h2>
              <div className="tags">
                {analysis.targetAudience.map((audience, index) => (
                  <Badge key={`${index}-${audience}`}>{audience}</Badge>
                ))}
              </div>
              <h3 className="mb-3 mt-6">购买动机</h3>
              <InsightList items={analysis.purchaseMotivations} />
            </section>
          </div>
          <div className="analysis-two analysis-section">
            <section className="panel content-panel">
              <h2>商品优势</h2>
              <InsightList items={analysis.strengths} />
            </section>
            <section className="panel content-panel">
              <h2>商品弱点 / 待验证</h2>
              <InsightList items={analysis.weaknesses} />
            </section>
          </div>
          <Cards title="Marketing Angles" items={analysis.marketingAngles} />
          <section className="analysis-section">
            <h2>TikTok / Reels / Shorts Hooks</h2>
            <div className="panel">
              {analysis.hooks.map((hook, index) => (
                <div className="hook-row" key={`${index}-${hook}`}>
                  <span className="hook-number">{String(index + 1).padStart(2, '0')}</span>
                  <p>{hook}</p>
                  <CopyButton value={hook} />
                </div>
              ))}
            </div>
          </section>
          <section className="analysis-section">
            <div className="section-header">
              <h2>Short Video Script</h2>
              <CopyButton value={analysis.shortVideoScript} label="Copy Script" />
            </div>
            <div className="panel">
              {parseScript(analysis.shortVideoScript).map((step, index) => (
                <div className="script-step" key={`${index}-${step.label}`}>
                  <span className="script-label">{step.label}</span>
                  <p>{step.content}</p>
                </div>
              ))}
            </div>
          </section>
          <Prompts title="AI Image Prompts" items={analysis.imagePrompts} />
          <Prompts title="AI Video Prompts" items={analysis.videoPrompts} />
          <p className="notice">分析包含基于资料的推测。发布前请核对商品事实、价格和效果表述。</p>
        </>
      )}
    </>
  );
}
