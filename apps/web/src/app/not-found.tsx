import Link from 'next/link';
import { EmptyState } from '../components/ui';
export default function NotFound() {
  return (
    <EmptyState
      title="没有找到这个页面"
      description="商品可能已被删除，返回素材库继续浏览。"
      action={
        <Link className="button button-primary" href="/products">
          返回商品库
        </Link>
      }
    />
  );
}
