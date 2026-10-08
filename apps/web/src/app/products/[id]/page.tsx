import { ProductDetail } from '../../../components/product-detail';
export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const productId = decodeURIComponent(id);
  return <ProductDetail key={productId} id={productId} initialTab={tab} />;
}
