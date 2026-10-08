'use client';
import { ErrorNotice, PageHeading } from '../components/ui';
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <PageHeading title="页面暂时无法加载" description="你的本地素材仍然保留。" />
      <ErrorNotice message="加载遇到问题，请重试并检查工作台是否正在运行。" onRetry={reset} />
    </>
  );
}
