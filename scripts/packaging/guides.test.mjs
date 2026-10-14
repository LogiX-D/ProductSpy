import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PORTABLE_GUIDES, portableGuide } from './guides.mjs';
import { workspace } from './files.mjs';

describe('portable user guide links', () => {
  it('keeps bundled guides local and resolves the renamed entrypoint/privacy', () => {
    expect(
      portableGuide(
        '[使用](release-candidate-guide.md) [隐私](../PRIVACY.md) [安装](windows-guide.md#install)',
      ),
    ).toBe('[使用](release-candidate-guide.md) [隐私](PRIVACY.md) [安装](FIRST-RUN.md#install)');
  });
  it('routes evidence files to source docs instead of shipping broken local links', () => {
    expect(
      portableGuide('[验收](phase20-validation.md) [结果](phase12-quality-results.json#data)'),
    ).toBe(
      '[验收](https://github.com/LogiX-D/ProductSpy/blob/main/docs/phase20-validation.md) [结果](https://github.com/LogiX-D/ProductSpy/blob/main/docs/phase12-quality-results.json#data)',
    );
    expect(portableGuide('[官网](https://example.com/help?q=1#anchor)')).toBe(
      '[官网](https://example.com/help?q=1#anchor)',
    );
    expect(() => portableGuide('[文件](../../private.json)')).toThrow();
  });
  it('all current packaged guide links point to a shipped file or an explicit external source', async () => {
    const shipped = new Set(['FIRST-RUN.md', 'PRIVACY.md', ...PORTABLE_GUIDES]);
    for (const file of ['windows-guide.md', ...PORTABLE_GUIDES]) {
      const guide = portableGuide(await readFile(resolve(workspace, 'docs', file), 'utf8'));
      for (const [, target] of guide.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        if (/^(?:https?:|mailto:)/i.test(target)) continue;
        expect(shipped.has(target), `${file} has unshipped help link ${target}`).toBe(true);
      }
    }
  });
});
