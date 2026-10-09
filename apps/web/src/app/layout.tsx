import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { WorkspaceShell } from '../components/workspace-shell';
import './globals.css';
import '../components/workspace.css';
import '../components/analysis.css';

export const metadata: Metadata = {
  title: 'ProductSpy — 竞品素材工作台',
  description: '采集 Amazon 商品素材，分析卖点与短视频营销角度。',
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <WorkspaceShell>{children}</WorkspaceShell>
      </body>
    </html>
  );
}
