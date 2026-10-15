import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const source = await readFile(new URL('../src/popup/styles.css', import.meta.url), 'utf8');
const css = postcss.parse(source);
const roots = new Set(['html', 'body', '#root', '.popup-shell']);
const dimensions = /^(?:(?:min|max)-)?(?:width|height|inline-size|block-size)$/;
const viewportUnit = /(?:\d|\.)(?:s|l|d)?v(?:w|h|i|b|min|max)\b/i;

function declarations(selector: string): Map<string, string> {
  const values = new Map<string, string>();
  css.walkRules((rule) => {
    if (rule.selectors.includes(selector)) {
      rule.walkDecls((declaration) => {
        values.set(declaration.prop, declaration.value);
      });
    }
  });
  return values;
}

describe('action Popup intrinsic sizing contract (static CSS, not native Chrome acceptance)', () => {
  it('never feeds viewport units, percentages or unresolved variables into root dimensions', () => {
    let checked = 0;
    css.walkRules((rule) => {
      if (!rule.selectors.some((selector) => roots.has(selector))) return;
      rule.walkDecls((declaration) => {
        if (!dimensions.test(declaration.prop)) return;
        // A grouped rule applies independently to every matching root node.
        checked += rule.selectors.filter((selector) => roots.has(selector)).length;
        expect(declaration.value, `${rule.selector}: ${declaration.prop}`).not.toMatch(
          viewportUnit,
        );
        expect(declaration.value).not.toMatch(/%|var\(|calc\(|min\(|max\(|clamp\(/i);
      });
    });
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  for (const selector of roots) {
    it(`gives ${selector} stable width and height before React or asynchronous initialization`, () => {
      const values = declarations(selector);
      expect(values.get('width')).toBe('400px');
      expect(values.get('min-width')).toBe('400px');
      expect(values.get('height')).toBe('420px');
    });
  }

  it('keeps long content inside a shrinkable vertical scroll region', () => {
    const shell = declarations('.popup-shell');
    const content = declarations('.popup-content');
    expect(shell.get('display')).toBe('flex');
    expect(shell.get('flex-direction')).toBe('column');
    expect(content.get('flex')).toBe('1');
    expect(content.get('min-height')).toBe('0');
    expect(content.get('min-width')).toBe('0');
    expect(content.get('overflow-y')).toBe('auto');
    expect(content.get('overflow-x')).toBe('hidden');
    expect(declarations('body').get('overflow-wrap')).toBe('anywhere');
    expect(declarations('.popup-header').get('flex-shrink')).toBe('0');
    expect(declarations('.popup-footer').get('flex-shrink')).toBe('0');
  });
});
