import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const extension = resolve(
  argument('--extension', 'artifacts/ProductSpy-1.0.0-rc.1-windows-x64/extension'),
);
const startedAt = new Date().toISOString();
const output = resolve(
  argument('--output', `.test-data/rc2-hotfix/${startedAt.replace(/[:.]/g, '-')}`),
);
const profile = resolve(output, 'profile');
await mkdir(output, { recursive: true });
const manifestBytes = await readFile(resolve(extension, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
async function inventory(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('Diagnostic extension must not contain symbolic links');
    if (entry.isDirectory()) files.push(...(await inventory(path)));
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push({
        path: relative(extension, path).replaceAll('\\', '/'),
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
const extensionInventory = await inventory(extension);
const requestedScale = Number(argument('--scale', '1'));
if (![1, 1.25, 1.5, 2].includes(requestedScale))
  throw new Error('Supported QA scale factors: 1, 1.25, 1.5, 2');
const report = {
  schemaVersion: 1,
  startedAt,
  extension: {
    version: manifest.version,
    versionName: manifest.version_name,
    manifestSha256: sha256(manifestBytes),
    files: extensionInventory,
    treeSha256: sha256(JSON.stringify(extensionInventory)),
  },
  browser: {
    distribution: 'Chrome for Testing',
    stableChromeManualAcceptance: false,
    headless: !process.argv.includes('--headed'),
    requestedSimulatedScaleFactor: requestedScale,
    realWindowsDisplayScalingAcceptance: false,
  },
  method: {
    ordinaryTab:
      'A separate popup.html tab with the ordinary browser viewport; not an action popup',
    actionPopup:
      'CDP Extensions.triggerAction on an about:blank browser tab. Only a newly created extension target is accepted as the actual action popup. No viewport override or emulation is applied to that target.',
    requests: 'No Amazon navigation, pairing, library writes, media downloads, or AI calls',
  },
  measurements: [],
  errors: [],
  assertions: [],
};
let context;
let raw;
const wait = (milliseconds) => new Promise((complete) => setTimeout(complete, milliseconds));
const assertion = (name, passed, details) => {
  report.assertions.push({ name, passed, ...(details ? { details } : {}) });
};

function assertGeometry(value, prefix) {
  assertion(
    `${prefix}: actual action popup view`,
    value.extensionView.popup === true && value.extensionView.tab === false,
  );
  assertion(
    `${prefix}: native action viewport 400x420`,
    value.window.innerWidth === 400 && value.window.innerHeight === 420,
    value.window,
  );
  assertion(`${prefix}: React mounted`, value.reactMounted && value.rootChildCount === 1);
  assertion(
    `${prefix}: production CSS loaded`,
    value.stylesheetCount > 0 && value.stylesheets.every((sheet) => sheet.sheetAvailable),
  );
  for (const selector of ['html', 'body', '#root', '.popup-shell']) {
    const node = value.nodes[selector];
    assertion(
      `${prefix}: ${selector} fixed root bounds`,
      node.rect.width === 400 && node.rect.height === 420,
      node,
    );
    assertion(
      `${prefix}: ${selector} no horizontal overflow`,
      node.scrollWidth <= node.clientWidth,
      node,
    );
  }
  const content = value.nodes['.popup-content'];
  assertion(
    `${prefix}: content no horizontal overflow`,
    content.scrollWidth <= content.clientWidth,
    content,
  );
  assertion(
    `${prefix}: header remains visible`,
    value.nodes['.popup-header'].rect.width === 400 &&
      value.nodes['.popup-header'].rect.height >= 50 &&
      value.headerVisuallyContained,
  );
  const footer = value.nodes['.popup-footer'].rect;
  assertion(
    `${prefix}: footer stays in native viewport`,
    footer.y >= 0 && footer.y + footer.height <= value.window.innerHeight + 0.5,
    footer,
  );
}

async function connect(portFile) {
  const [port, endpoint] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  const pending = new Map();
  const events = [];
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const task = pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timeout);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    } else events.push(message);
  });
  await new Promise((complete, reject) => {
    socket.addEventListener('open', complete, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    events,
    send(method, params = {}, sessionId) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() {
      socket.close();
    },
  };
}

const measure = `(() => {
  const node = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return { present: false };
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      present: true,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
      css: Object.fromEntries(['width','height','minWidth','maxWidth','minHeight','maxHeight','display','position','overflow','overflowX','overflowY','flex','flexShrink','boxSizing'].map(key => [key, style[key]]))
    };
  };
  const header = document.querySelector('.popup-header');
  const headerRect = header?.getBoundingClientRect();
  const headerChildren = header ? [...header.querySelectorAll('*')].filter(element => element.textContent?.trim() === 'ProductSpy').map(element => {
    const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom };
  }) : [];
  return {
    capturedAt: new Date().toISOString(), location: location.href,
    readyState: document.readyState,
    extensionView: { popup: chrome.extension.getViews({ type: 'popup' }).includes(window), tab: chrome.extension.getViews({ type: 'tab' }).includes(window) },
    window: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height, screenAvailableWidth: screen.availWidth, screenAvailableHeight: screen.availHeight, screenAvailableLeft: screen.availLeft, screenAvailableTop: screen.availTop, visualViewportWidth: visualViewport?.width, visualViewportHeight: visualViewport?.height, visualViewportScale: visualViewport?.scale },
    nodes: Object.fromEntries(['html','body','#root','.popup-shell','.popup-header','.popup-content','.popup-footer'].map(selector => [selector, node(selector)])),
    reactMounted: !!document.querySelector('#root .popup-shell'),
    stylesheetCount: document.styleSheets.length,
    stylesheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map(element => ({ href: element.href, sheetAvailable: !!element.sheet })),
    rootChildCount: document.querySelector('#root')?.childElementCount ?? 0,
    headerChildren,
    headerVisuallyContained: !!headerRect && headerChildren.every(rect => rect.top >= headerRect.top && rect.bottom <= headerRect.bottom),
    visibleText: document.body.innerText,
    controls: [...document.querySelectorAll('button,input,summary,a')].map(element => ({ tag: element.tagName, text: element.textContent?.trim(), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))
  };
})()`;

async function collect(target, kind) {
  const attached = await raw.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;
  await raw.send('Runtime.enable', {}, sessionId);
  await raw.send('Log.enable', {}, sessionId);
  const evaluation = await raw.send(
    'Runtime.evaluate',
    { expression: measure, returnByValue: true },
    sessionId,
  );
  if (evaluation.exceptionDetails) throw new Error('Read-only measurement failed');
  const measurement = { kind, target: { ...target }, ...evaluation.result.value };
  try {
    const screenshot = await raw.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      sessionId,
    );
    const bytes = Buffer.from(screenshot.data, 'base64');
    await writeFile(resolve(output, `${kind}.png`), bytes);
    measurement.screenshot = { file: `${kind}.png`, sha256: sha256(bytes), bytes: bytes.length };
  } catch (error) {
    measurement.screenshotError = String(error);
  }
  report.measurements.push(measurement);
  return { sessionId, measurement };
}

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: report.browser.headless,
    viewport: { width: 1280, height: 800 },
    args: [
      '--enable-unsafe-extension-debugging',
      '--remote-debugging-port=0',
      `--force-device-scale-factor=${requestedScale}`,
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  report.browser.version = context.browser().version();
  raw = await connect(resolve(profile, 'DevToolsActivePort'));
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  const popupUrl = `chrome-extension://${id}/popup.html`;
  const ordinary = await context.newPage();
  ordinary.on('pageerror', (error) =>
    report.errors.push({ kind: 'ordinary-tab', error: String(error) }),
  );
  await ordinary.goto(popupUrl);
  await ordinary.getByText('首次采集说明', { exact: true }).waitFor();
  const ordinaryTargets = await raw.send('Target.getTargets', { filter: [{ exclude: false }] });
  const ordinaryTarget = ordinaryTargets.targetInfos.find(
    (target) => target.url === popupUrl && target.type === 'page',
  );
  if (!ordinaryTarget) throw new Error('Ordinary extension tab target was not identified');
  await collect(ordinaryTarget, 'ordinary-popup-tab');
  await ordinary.close();

  const tab = context.pages()[0];
  await tab.bringToFront();
  const before = await raw.send('Target.getTargets', { filter: [{ exclude: false }] });
  const tabTarget = before.targetInfos.find(
    (target) => target.type === 'tab' && target.url === tab.url(),
  );
  if (!tabTarget) throw new Error('Browser tab target was not identified');
  report.action = {
    invokedAt: new Date().toISOString(),
    method: 'Extensions.triggerAction',
    tabTargetId: tabTarget.targetId,
    beforeTargets: before.targetInfos,
  };
  report.action.response = await raw.send('Extensions.triggerAction', {
    id,
    targetId: tabTarget.targetId,
  });
  await wait(1000);
  const after = await raw.send('Target.getTargets', { filter: [{ exclude: false }] });
  report.action.afterTargets = after.targetInfos;
  const existingIds = new Set(before.targetInfos.map((target) => target.targetId));
  const actionTarget = after.targetInfos.find(
    (target) => !existingIds.has(target.targetId) && target.url === popupUrl,
  );
  if (!actionTarget) {
    report.action.outcome = 'actual-action-popup-target-not-available';
    report.action.note =
      'No real action popup measurement was made. The ordinary extension tab is not a substitute.';
  } else {
    report.action.outcome = 'actual-action-popup-target-observed';
    const actual = await collect(actionTarget, 'actual-action-popup');
    await wait(500);
    const later = await raw.send(
      'Runtime.evaluate',
      { expression: measure, returnByValue: true },
      actual.sessionId,
    );
    report.action.laterMeasurement = later.result.value;
    report.action.runtimeErrors = raw.events.filter(
      (event) =>
        event.sessionId === actual.sessionId &&
        ['Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method),
    );
    if (process.argv.includes('--assert-stable')) {
      report.syntheticLayoutTest = {
        source:
          'Synthetic layout content appended to this isolated extension action document for QA only',
        productionData: false,
        originalFrame: actual.measurement.window,
      };
      assertGeometry(actual.measurement, 'initial');
      assertion(
        'action: requested simulated device scale applied',
        Math.abs(actual.measurement.window.devicePixelRatio - requestedScale) < 0.01,
        { requested: requestedScale, measured: actual.measurement.window.devicePixelRatio },
      );
      await raw.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
          const content = document.querySelector('.popup-content');
          const test = document.createElement('section');
          test.dataset.productspySyntheticLayout = 'true';
          const long = document.createElement('p');
          long.textContent = 'SYNTHETIC_LAYOUT_ONLY_' + 'UnbrokenSyntheticLayoutText'.repeat(250);
          test.appendChild(long);
          for (let index = 0; index < 30; index += 1) {
            const paragraph = document.createElement('p');
            paragraph.textContent = '合成布局测试段落 ' + index + '，仅验证内部滚动与长文本换行，不是商品资料。';
            test.appendChild(paragraph);
          }
          content.appendChild(test);
          return true;
        })()`,
          returnByValue: true,
        },
        actual.sessionId,
      );
      await wait(200);
      const synthetic = await collect(actionTarget, 'actual-action-popup-synthetic-long-content');
      assertGeometry(synthetic.measurement, 'synthetic long content');
      const content = synthetic.measurement.nodes['.popup-content'];
      assertion(
        'synthetic: content scrolls internally',
        content.scrollHeight > content.clientHeight,
        content,
      );
      const scroll = await raw.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
          const content = document.querySelector('.popup-content');
          const before = content.scrollTop;
          content.scrollTop = 200;
          return { before, after: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight };
        })()`,
          returnByValue: true,
        },
        synthetic.sessionId,
      );
      report.syntheticLayoutTest.scroll = scroll.result.value;
      assertion(
        'synthetic: scrollTop responds to explicit scroll',
        scroll.result.value.after > 0,
        scroll.result.value,
      );
      for (const selector of [
        'html',
        'body',
        '#root',
        '.popup-shell',
        '.popup-header',
        '.popup-footer',
      ]) {
        assertion(
          `synthetic: ${selector} frame unchanged`,
          JSON.stringify(actual.measurement.nodes[selector].rect) ===
            JSON.stringify(synthetic.measurement.nodes[selector].rect),
          {
            before: actual.measurement.nodes[selector].rect,
            after: synthetic.measurement.nodes[selector].rect,
          },
        );
      }
      report.action.runtimeErrors = raw.events.filter(
        (event) =>
          [actual.sessionId, synthetic.sessionId].includes(event.sessionId) &&
          event.method === 'Runtime.exceptionThrown',
      );
      assertion(
        'action: no observed runtime exceptions',
        report.action.runtimeErrors.length === 0,
        report.action.runtimeErrors,
      );
      assertion('ordinary tab: no page errors', report.errors.length === 0, report.errors);
      const failed = report.assertions.filter((item) => !item.passed);
      if (failed.length)
        throw new Error(
          `Action Popup layout assertions failed: ${failed.map((item) => item.name).join('; ')}`,
        );
    }
    if (process.argv.includes('--css-matrix')) {
      report.cssInterventions = [];
      const variants = [
        { name: 'baseline', css: '' },
        { name: 'width-only', css: 'body { max-width: none !important; }' },
        { name: 'height-only', css: 'body { height: 600px !important; }' },
        {
          name: 'both-with-explicit-roots',
          css: 'html, body, #root, .popup-shell { width: 400px !important; min-width: 400px !important; } body { max-width: none !important; height: 600px !important; }',
        },
      ];
      await raw.send('Target.closeTarget', { targetId: actionTarget.targetId });
      for (const variant of variants) {
        await tab.bringToFront();
        const previous = await raw.send('Target.getTargets', { filter: [{ exclude: false }] });
        const existing = new Set(previous.targetInfos.map((target) => target.targetId));
        await raw.send('Extensions.triggerAction', { id, targetId: tabTarget.targetId });
        await wait(600);
        const current = await raw.send('Target.getTargets', { filter: [{ exclude: false }] });
        const target = current.targetInfos.find(
          (item) => !existing.has(item.targetId) && item.url === popupUrl && item.type === 'page',
        );
        if (!target)
          throw new Error(`No independent action target for CSS variant ${variant.name}`);
        const original = await collect(target, `matrix-${variant.name}-before`);
        if (variant.css) {
          await raw.send(
            'Runtime.evaluate',
            {
              expression: `(() => { const style = document.createElement('style'); style.dataset.productspyQaCssIntervention = 'true'; style.textContent = ${JSON.stringify(variant.css)}; document.head.appendChild(style); return true; })()`,
              returnByValue: true,
            },
            original.sessionId,
          );
          await wait(300);
        }
        const changed = await collect(target, `matrix-${variant.name}-after`);
        report.cssInterventions.push({
          name: variant.name,
          injectedCss: variant.css,
          frozenFilesModified: false,
          independentActionTarget: target.targetId,
          before: original.measurement,
          after: changed.measurement,
          runtimeErrors: raw.events.filter(
            (event) =>
              [original.sessionId, changed.sessionId].includes(event.sessionId) &&
              ['Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method),
          ),
        });
        await raw.send('Target.closeTarget', { targetId: target.targetId });
      }
    }
    if (process.argv.includes('--height-matrix')) {
      report.heightInterventions = [];
      const heights = argument('--heights', '480,440,420').split(',').map(Number);
      if (!heights.length || heights.some((height) => ![480, 440, 420].includes(height)))
        throw new Error('Height diagnostic candidates must be 480, 440, or 420');
      await raw.send('Target.closeTarget', { targetId: actionTarget.targetId });
      for (const height of heights) {
        await tab.bringToFront();
        const previous = await raw.send('Target.getTargets', { filter: [{ exclude: false }] });
        const existing = new Set(previous.targetInfos.map((target) => target.targetId));
        await raw.send('Extensions.triggerAction', { id, targetId: tabTarget.targetId });
        await wait(600);
        const current = await raw.send('Target.getTargets', { filter: [{ exclude: false }] });
        const target = current.targetInfos.find(
          (item) => !existing.has(item.targetId) && item.url === popupUrl && item.type === 'page',
        );
        if (!target) throw new Error(`No independent action target for height ${height}`);
        const before = await collect(target, `height-${height}-before`);
        const css = `html, body, #root, .popup-shell { height: ${height}px !important; max-height: ${height}px !important; min-height: 0 !important; }`;
        await raw.send(
          'Runtime.evaluate',
          {
            expression: `(() => { const style = document.createElement('style'); style.dataset.productspyQaHeight = 'true'; style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style); return true; })()`,
            returnByValue: true,
          },
          before.sessionId,
        );
        await wait(300);
        const resized = await collect(target, `height-${height}-resized`);
        await raw.send(
          'Runtime.evaluate',
          {
            expression: `(() => {
            const content = document.querySelector('.popup-content');
            const synthetic = document.createElement('section');
            synthetic.dataset.productspySyntheticLayout = 'true';
            const long = document.createElement('p');
            long.textContent = 'SYNTHETIC_LAYOUT_ONLY_' + 'UnbrokenSyntheticLayoutText'.repeat(250);
            synthetic.appendChild(long);
            for (let index = 0; index < 30; index += 1) {
              const paragraph = document.createElement('p');
              paragraph.textContent = '合成布局测试段落 ' + index + '，仅验证内部滚动与长文本换行。';
              synthetic.appendChild(paragraph);
            }
            content.appendChild(synthetic);
            return true;
          })()`,
            returnByValue: true,
          },
          resized.sessionId,
        );
        await wait(200);
        const long = await collect(target, `height-${height}-long-content`);
        const scrolled = await raw.send(
          'Runtime.evaluate',
          {
            expression: `(() => { const content = document.querySelector('.popup-content'); content.scrollTop = 200; return { scrollTop: content.scrollTop, clientHeight: content.clientHeight, scrollHeight: content.scrollHeight }; })()`,
            returnByValue: true,
          },
          long.sessionId,
        );
        const measured = long.measurement;
        const footer = measured.nodes['.popup-footer'].rect;
        report.heightInterventions.push({
          height,
          injectedCss: css,
          syntheticContent: true,
          actualWindowsDpiAcceptance: false,
          before: before.measurement,
          resized: resized.measurement,
          longContent: measured,
          scroll: scrolled.result.value,
          checks: {
            actualPopup:
              measured.extensionView.popup === true && measured.extensionView.tab === false,
            viewportMatchesCandidate:
              measured.window.innerWidth === 400 && measured.window.innerHeight === height,
            footerInsideActualViewport:
              footer.y >= 0 && footer.y + footer.height <= measured.window.innerHeight + 0.5,
            internalVerticalScroll:
              scrolled.result.value.scrollTop > 0 &&
              scrolled.result.value.scrollHeight > scrolled.result.value.clientHeight,
            noHorizontalOverflow: ['html', 'body', '#root', '.popup-shell', '.popup-content'].every(
              (selector) =>
                measured.nodes[selector].scrollWidth <= measured.nodes[selector].clientWidth,
            ),
            unchangedOuterFrame:
              JSON.stringify(resized.measurement.window) === JSON.stringify(measured.window),
            unchangedFooter:
              JSON.stringify(resized.measurement.nodes['.popup-footer'].rect) ===
              JSON.stringify(footer),
          },
          runtimeErrors: raw.events.filter(
            (event) =>
              [before.sessionId, resized.sessionId, long.sessionId].includes(event.sessionId) &&
              event.method === 'Runtime.exceptionThrown',
          ),
        });
        await raw.send('Target.closeTarget', { targetId: target.targetId });
      }
    }
  }
} catch (error) {
  report.errors.push({ kind: 'diagnostic-error', error: String(error) });
  process.exitCode = 1;
} finally {
  raw?.close();
  await context?.close();
  report.completedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        output,
        actionOutcome: report.action?.outcome,
        measurements: report.measurements.map((item) => ({
          kind: item.kind,
          targetType: item.target.type,
          subtype: item.target.subtype,
          window: item.window,
          body: item.nodes.body.rect,
          root: item.nodes['#root'].rect,
          shell: item.nodes['.popup-shell'].rect,
          header: item.nodes['.popup-header'].rect,
          reactMounted: item.reactMounted,
          stylesheetCount: item.stylesheetCount,
        })),
        errors: report.errors,
      },
      null,
      2,
    ),
  );
}
