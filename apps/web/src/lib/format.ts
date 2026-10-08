import type { Product } from '@productspy/shared';
export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
}
export function formatPrice(product: Pick<Product, 'price' | 'currency'>): string {
  if (!product.price) return '价格暂缺';
  return product.currency &&
    !product.price.toUpperCase().includes(product.currency.toUpperCase()) &&
    !/[$€£¥₹￥]/.test(product.price)
    ? `${product.currency} ${product.price}`
    : product.price;
}
