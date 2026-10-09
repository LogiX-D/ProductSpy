'use client';

import { useState } from 'react';
import { Puzzle } from 'lucide-react';
import { workspaceCopy as copy } from './workspace-copy';

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
