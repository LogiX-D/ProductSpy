export const PORTABLE_GUIDES = [
  'ai-provider-guide.md',
  'phase12-ai-quality.md',
  'library-guide.md',
  'media-comparison-guide.md',
  'content-creation-guide.md',
  'workflow-backup-guide.md',
  'release-candidate-guide.md',
];

/** Guides live beside FIRST-RUN in the ZIP; historical reports stay on GitHub. */
export function portableGuide(source) {
  return source.replace(/\]\(([^)#]+)(#[^)]*)?\)/g, (match, target, anchor = '') => {
    if (/^(?:https?:|mailto:)/i.test(target)) return match;
    if (target === '../PRIVACY.md' || target === 'PRIVACY.md') return `](PRIVACY.md${anchor})`;
    if (target === 'windows-guide.md') return `](FIRST-RUN.md${anchor})`;
    if (PORTABLE_GUIDES.includes(target)) return match;
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.(?:md|json)$/.test(target))
      return `](https://github.com/LogiX-D/ProductSpy/blob/main/docs/${target}${anchor})`;
    throw new Error(`Unsupported portable help link: ${target}`);
  });
}
