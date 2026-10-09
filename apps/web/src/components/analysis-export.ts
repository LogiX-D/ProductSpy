import type { Product, ProductAnalysis } from '@productspy/shared';
import { analysisAllText, analysisSectionText, analysisSections } from './analysis-utils';

export const analysisFieldLabels: Record<keyof ProductAnalysis, string> = {
  summary: '商品总结',
  sellingPoints: '核心卖点',
  targetAudience: '目标用户',
  purchaseMotivations: '购买动机',
  painPoints: '用户痛点',
  strengths: '商品优势',
  weaknesses: '不足与待验证',
  marketingAngles: '营销角度',
  hooks: '开场文案',
  shortVideoScript: '短视频脚本',
  imagePrompts: '图片提示词',
  videoPrompts: '视频提示词',
};

export function analysisDifferences(
  before: ProductAnalysis,
  after: ProductAnalysis,
): (keyof ProductAnalysis)[] {
  return (Object.keys(analysisFieldLabels) as (keyof ProductAnalysis)[]).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

export function analysisFieldText(value: string | string[]): string {
  return Array.isArray(value) ? value.map((item) => `• ${item}`).join('\n') : value;
}

export function exportAnalysisText(
  product: Pick<Product, 'title' | 'sourceId' | 'url'>,
  analysis: ProductAnalysis,
  format: 'md' | 'txt',
  provenance = '',
): string {
  const notice =
    '内容来源：商品页面文字；用户画像、痛点和营销建议包含 AI 推断。未采集或分析真实评论正文。发布前请核对商品事实与效果表述。';
  if (format === 'txt')
    return [
      product.title,
      `ASIN：${product.sourceId}`,
      product.url,
      provenance,
      notice,
      analysisAllText(analysis),
    ]
      .filter(Boolean)
      .join('\n\n');
  const title = product.title.replace(/[\r\n]+/g, ' ');
  return (
    [
      `# ${title}`,
      `ASIN：${product.sourceId}\n\n商品地址：${product.url}`,
      provenance,
      `> ${notice}`,
      ...analysisSections.map(({ id, label }) => {
        const section = analysisSectionText(analysis, id);
        return `## ${label}\n\n${section.slice(label.length + 1)}`;
      }),
    ]
      .filter(Boolean)
      .join('\n\n') + '\n'
  );
}

export function analysisExportFilename(sourceId: string, format: 'md' | 'txt'): string {
  const safe = sourceId.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'product';
  return `ProductSpy-${safe}-analysis.${format}`;
}

export function downloadAnalysis(
  product: Pick<Product, 'title' | 'sourceId' | 'url'>,
  analysis: ProductAnalysis,
  format: 'md' | 'txt',
  provenance = '',
): void {
  const text = exportAnalysisText(product, analysis, format, provenance);
  const blob = new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = analysisExportFilename(product.sourceId, format);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
