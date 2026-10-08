'use client';

import { useState } from 'react';
import { Puzzle } from 'lucide-react';

export const OPEN_SETUP_EVENT = 'productspy:open-setup';

export function OpenSetupButton() {
  return (
    <button
      type="button"
      className="button button-primary"
      onClick={() => window.dispatchEvent(new Event(OPEN_SETUP_EVENT))}
    >
      <Puzzle size={16} />
      开始首次使用
    </button>
  );
}

export function FirstUseGuide() {
  const [developer, setDeveloper] = useState(false);
  return (
    <div>
      <div className="mt-4 flex gap-2" aria-label="安装方式">
        <button
          type="button"
          aria-pressed={!developer}
          onClick={() => setDeveloper(false)}
          className={`rounded-lg border px-3 py-2 text-xs font-medium ${!developer ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-200 text-slate-500'}`}
        >
          Windows 便携版
        </button>
        <button
          type="button"
          aria-pressed={developer}
          onClick={() => setDeveloper(true)}
          className={`rounded-lg border px-3 py-2 text-xs font-medium ${developer ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-200 text-slate-500'}`}
        >
          开发者源码版
        </button>
      </div>
      <ol className="my-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-600">
        <li>
          <strong className="text-slate-800">启动工作台。</strong>{' '}
          {developer ? (
            <>
              在项目目录运行 <code className="rounded bg-slate-100 px-1 text-xs">pnpm dev</code>
              ；安装扩展前运行 <code className="rounded bg-slate-100 px-1 text-xs">pnpm build</code>
              。
            </>
          ) : (
            <>
              解压便携包，双击{' '}
              <code className="rounded bg-slate-100 px-1 text-xs">ProductSpy.cmd</code>
              ，工作台会自动打开。无需安装 Node.js 或 pnpm。
            </>
          )}
        </li>
        <li>
          <strong className="text-slate-800">安装 Chrome 扩展。</strong> 在 Chrome 地址栏输入{' '}
          <code className="rounded bg-slate-100 px-1 text-xs">chrome://extensions</code>
          ，打开「开发者模式」，点击「加载已解压的扩展程序」，选择{' '}
          <code className="rounded bg-slate-100 px-1 text-xs">
            {developer ? 'apps/extension/dist' : '便携包中的 extension 文件夹'}
          </code>
          ，将扩展固定到工具栏。
        </li>
        <li>
          <strong className="text-slate-800">安全配对。</strong>{' '}
          在下方点击「生成配对码」，复制到扩展的「工作台配对码」，点击「连接工作台」。有效期 2
          分钟；过期后重新生成。
        </li>
        <li>
          <strong className="text-slate-800">打开 Amazon 商品。</strong> 等页面加载完成后点击
          ProductSpy。首次打开时阅读采集说明，点击「同意并开始采集」。切换颜色或尺寸后，再次识别当前商品。
        </li>
        <li>
          <strong className="text-slate-800">采集并保存。</strong> 检查标题、价格与
          ASIN，点击「保存到素材库」。断线时商品暂存于扩展，启动工作台后点击「重试同步」。
        </li>
        <li>
          <strong className="text-slate-800">进行 AI 分析。</strong> 在商品库打开详情，选择 AI
          Analysis，点击「开始 AI 分析」。未配置 Key 时可直接使用 Mock 演示，商品与分析保留在本机。
        </li>
      </ol>
      <p className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">
        当前扩展尚未在 Chrome Web Store 上架；普通用户也需按上述步骤加载本地扩展。保留 extension
        文件夹，不要在安装后删除。工作台标签页可以关闭，服务需保持运行；退出时在启动器点击「停止并退出」。便携版通过启动器「AI
        设置」配置自己的 Key，商品保存在独立用户数据目录，更新程序不会清空商品。
      </p>
    </div>
  );
}
