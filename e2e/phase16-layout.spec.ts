import { test, expect } from './test-fixtures';

// Normal viewport checks do not reproduce or resolve the user's 55 × 58 blank
// window. That symptom remains a separate manual browser acceptance item.
for (const viewport of [
  { width: 1280, height: 720 },
  { width: 375, height: 812 },
  { width: 320, height: 568 },
]) {
  test(`installation dialog remains readable and reachable at ${viewport.width} × ${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    // Never generate/revoke a real pairing code, mutate a product or request AI.
    // The page itself uses the existing authenticated local session mechanism.
    let rejectedWrites = 0;
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== 'http://127.0.0.1:3000') {
        await route.abort('blockedbyclient');
        return;
      }
      if (
        !['GET', 'HEAD'].includes(request.method()) &&
        !(url.pathname === '/api/session' && request.method() === 'POST')
      ) {
        rejectedWrites++;
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await page.goto('/');
    const setup = page.getByRole('button', { name: '查看安装与配对说明', exact: true });
    await setup.click();
    const dialog = page.getByRole('dialog', { name: '首次使用 ProductSpy', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThanOrEqual(Math.min(280, viewport.width - 24));
    expect(bounds!.height).toBeGreaterThanOrEqual(Math.min(300, viewport.height - 80));
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    const geometry = await dialog.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      instructionFont: Number.parseFloat(
        getComputedStyle(element.querySelector('.ws-guide-steps')!).fontSize,
      ),
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.instructionFont).toBeGreaterThanOrEqual(13);
    const steps = dialog.locator('.ws-guide-steps > li');
    await expect(steps).toHaveCount(4);
    for (const [index, title] of [
      '安装 Chrome 扩展',
      '连接工作台',
      '采集第一个商品',
      '打开商品继续分析',
    ].entries()) {
      const step = steps.nth(index);
      await expect(step.locator('strong')).toHaveText(title);
      await expect(step.locator('p')).not.toBeEmpty();
      await step.scrollIntoViewIfNeeded();
      await expect(step).toBeInViewport();
    }
    const generate = dialog.getByRole('button', { name: '生成配对码', exact: true });
    await generate.scrollIntoViewIfNeeded();
    await expect(generate).toBeEnabled();
    await expect(generate).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath('pairing-button-reachable.png'),
      fullPage: false,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(setup).toBeFocused();
    expect(rejectedWrites).toBe(0);
  });
}
