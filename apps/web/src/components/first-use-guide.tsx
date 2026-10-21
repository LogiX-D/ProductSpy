'use client';

import { useState } from 'react';
import { Puzzle } from 'lucide-react';
import { workspaceCopy as copy } from './workspace-copy';
import { isLegacyMode } from '../lib/session';

export const OPEN_SETUP_EVENT = 'productspy:open-setup';

export function OpenSetupButton() {
  return (
    <button
      type="button"
      className="button button-primary"
      onClick={() => window.dispatchEvent(new Event(OPEN_SETUP_EVENT))}
    >
      <Puzzle size={16} />
      {copy.guide.open}
    </button>
  );
}

export function FirstUseGuide() {
  const [developer, setDeveloper] = useState(false);
  if (!isLegacyMode)
    return (
      <div className="ws-first-use-guide">
        <ol className="ws-guide-steps">
          <li>
            <strong>安装 Chrome 扩展</strong>
            <p>
              当前预览版在 <code>chrome://extensions</code> 开启开发者模式，加载构建产物{' '}
              <code>apps/extension/dist</code>。正式商店入口将在发布审核完成后提供。
            </p>
          </li>
          <li>
            <strong>登录 ProductSpy 账号</strong>
            <p>
              安装后即可打开扩展使用。扩展自动连接当前浏览器已登录的账号；未登录时，点击扩展中的「登录
              ProductSpy」，完成网页登录后回到扩展继续。
            </p>
          </li>
          <li>
            <strong>采集商品并同步</strong>
            <p>
              打开 Amazon
              商品详情页，阅读并同意采集说明后保存商品。网络异常时商品保留在当前账号的扩展队列，联网后自动重试，也可手动重试。
            </p>
          </li>
          <li>
            <strong>在工作台继续创作</strong>
            <p>
              进入商品详情分析卖点，保存结果后可在另一设备登录同一账号查看。演示模式会明确标注，AI
              请求消耗当前套餐额度。
            </p>
          </li>
        </ol>
        <p className="small muted">
          使用在线工作台无需启动 Windows
          程序。重启浏览器后会重新连接已登录账号，原账号的待同步资料仍会保留。采集与隐私说明见{' '}
          <a className="ws-text-link" href="/privacy" target="_blank" rel="noreferrer">
            隐私说明
          </a>
          。
        </p>
      </div>
    );
  return (
    <div className="ws-first-use-guide">
      <div className="ws-install-options" role="group" aria-label={copy.guide.installation}>
        <button type="button" aria-pressed={!developer} onClick={() => setDeveloper(false)}>
          {copy.guide.portable}
        </button>
        <button type="button" aria-pressed={developer} onClick={() => setDeveloper(true)}>
          {copy.guide.developer}
        </button>
      </div>
      <ol className="ws-guide-steps">
        <li>
          <strong>{copy.guide.installTitle}</strong>
          <p>
            {copy.guide.installBefore} <code>chrome://extensions</code>
            {copy.guide.installAfter}{' '}
            <code>{developer ? 'apps/extension/dist' : copy.guide.folder}</code>
            {copy.guide.pin}
          </p>
        </li>
        <li>
          <strong>{copy.guide.pairTitle}</strong>
          <p>{copy.guide.pair}</p>
        </li>
        <li>
          <strong>{copy.guide.saveTitle}</strong>
          <p>{copy.guide.save}</p>
        </li>
        <li>
          <strong>{copy.guide.analyzeTitle}</strong>
          <p>{copy.guide.analyze}</p>
        </li>
      </ol>
      <details className="ws-guide-more">
        <summary>{copy.guide.more}</summary>
        <p>{developer ? copy.guide.developerStart : copy.guide.portableStart}</p>
        <p>{copy.guide.sync}</p>
        <p>{copy.guide.update}</p>
      </details>
    </div>
  );
}
