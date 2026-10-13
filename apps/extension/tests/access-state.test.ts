import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { isAmazonVerificationPage } from '../src/extractors/access-state';
describe('normal Amazon access restrictions', () => {
  it.each(['/errors/validateCaptcha', '/errors_page/validateCaptcha'])(
    'recognizes %s without submitting verification',
    (action) => {
      expect(
        isAmazonVerificationPage(new JSDOM(`<form action="${action}"></form>`).window.document),
      ).toBe(true);
    },
  );
  it('does not mistake ordinary product content for verification', () => {
    expect(
      isAmazonVerificationPage(
        new JSDOM(
          '<h1 id="productTitle">Robot vacuum cleaner</h1><form action="/gp/cart/add.html"></form>',
        ).window.document,
      ),
    ).toBe(false);
  });
});
