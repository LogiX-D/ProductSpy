'use client';

import Link from 'next/link';
import { ExternalLink, X } from 'lucide-react';
import type { Product } from '@productspy/shared';
import { Badge, ProductImage } from './ui';

const unknown = '未知';
export function comparisonTimestamp(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
export function comparisonCountry(product: Product): string {
  try {
    return new URL(product.url).hostname.replace(/^www\./, '');
  } catch {
    return unknown;
  }
}
type ComparisonRow = {
  label: string;
  values: (product: Product) => string[];
  note?: string;
};
const rows: ComparisonRow[] = [
  { label: '品牌', values: (product) => [product.brand || unknown] },
  { label: 'ASIN', values: (product) => [product.sourceId] },
  { label: '国家站', values: (product) => [comparisonCountry(product)] },
  {
    label: '页面采集价格',
    values: (product) => [product.price || unknown],
    note: '历史页面记录，非实时价格；不对不同币种排序。',
  },
  { label: '货币', values: (product) => [product.currency || unknown] },
  {
    label: '评分',
    values: (product) => [product.rating === undefined ? unknown : String(product.rating)],
  },
  {
    label: '评论数量',
    values: (product) => [
      product.reviewCount === undefined ? unknown : product.reviewCount.toLocaleString('zh-CN'),
    ],
    note: '未采集评论正文，数量不代表评论内容分析。',
  },
  {
    label: '主要卖点',
    values: (product) => (product.bulletPoints.length ? product.bulletPoints : [unknown]),
    note: '商家页面的宣称，未独立验证。',
  },
  {
    label: '页面列出的规格',
    values: (product) =>
      product.specifications?.length
        ? product.specifications.map((item) => `${item.name}：${item.value}`)
        : [unknown],
    note: '仅展示采集到的商家页面规格，未独立验证。',
  },
  {
    label: '图片 / 视频',
    values: (product) => [
      `${new Set([product.mainImage, ...product.images].filter(Boolean)).size} 张 / ${product.videos.length} 条`,
    ],
  },
  { label: '首次采集', values: (product) => [comparisonTimestamp(product.createdAt)] },
  { label: '快照资料更新', values: (product) => [comparisonTimestamp(product.updatedAt)] },
];

export function ComparisonTable({
  products,
  currentProducts,
  highlight,
  disabled,
  onRemove,
}: {
  products: Product[];
  currentProducts: Product[];
  highlight: boolean;
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  const current = new Map(currentProducts.map((product) => [product.id, product]));
  return (
    <div
      className="comparison-table-wrap"
      role="region"
      aria-label="商品对比表，可横向滚动"
      tabIndex={0}
    >
      <table className="comparison-table">
        <caption className="sr-only">历史采集资料对比，差异高亮不代表优劣判断</caption>
        <thead>
          <tr>
            <th scope="col">对比项目</th>
            {products.map((product) => {
              const live = current.get(product.id);
              return (
                <th scope="col" key={product.id}>
                  <div className="comparison-product-heading">
                    <ProductImage
                      src={product.mainImage ?? product.images[0]}
                      alt={product.title}
                    />
                    <button
                      className="ws-icon-button"
                      type="button"
                      aria-label={`移除对比 ${product.sourceId}`}
                      disabled={disabled}
                      onClick={() => onRemove(product.id)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <p className="comparison-product-title">{product.title}</p>
                  <div className="ws-inline comparison-product-links">
                    {live ? (
                      <Link href={`/products/${encodeURIComponent(product.id)}`}>查看商品</Link>
                    ) : (
                      <Badge tone="warning">原商品已删除 · 保留快照</Badge>
                    )}
                    <a
                      href={product.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`打开 Amazon ${product.sourceId}`}
                    >
                      <ExternalLink size={13} />
                    </a>
                  </div>
                  {live && live.updatedAt !== product.updatedAt && (
                    <p className="comparison-source-warning">商品库已更新；当前仍为保存时快照。</p>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const values = products.map(row.values);
            const differs = new Set(values.map((value) => JSON.stringify(value))).size > 1;
            return (
              <tr
                key={row.label}
                className={highlight && differs ? 'comparison-different' : undefined}
              >
                <th scope="row">
                  <span>{row.label}</span>
                  {row.note && <small>{row.note}</small>}
                </th>
                {products.map((product, index) => (
                  <td key={product.id}>
                    {values[index].length === 1 ? (
                      <span
                        className={values[index][0] === unknown ? 'comparison-unknown' : undefined}
                      >
                        {values[index][0]}
                      </span>
                    ) : (
                      <ul>
                        {values[index].map((value, itemIndex) => (
                          <li key={itemIndex}>{value}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
