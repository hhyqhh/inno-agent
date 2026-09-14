/**
 * Read-only responsive browser regression (does not send chats or save settings).
 * Start the web dev server first. Supply Playwright externally, without adding
 * a production dependency: PLAYWRIGHT_MODULE=/path/to/playwright node scripts/mobile-layout-smoke.cjs
 * Optional: MOBILE_TEST_URL, MOBILE_TEST_OUTPUT, CHROMIUM_PATH, MOBILE_TEST_SESSION_TITLE.
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const base = process.env.MOBILE_TEST_URL || 'http://localhost:5173';
const output = process.env.MOBILE_TEST_OUTPUT || path.join(os.tmpdir(), 'inno-mobile-smoke');
const sizes = [[320,568],[375,667],[390,844],[430,932],[768,1024],[844,390],[960,800],[1440,900]];

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--disable-gpu'] });
  const results = [];
  try {
    for (const [width, height] of sizes) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: width <= 960, hasTouch: width <= 960, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const check = async (name) => {
        await page.waitForTimeout(280);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width} ${name}: document overflow`);
        results.push({ width, height, name });
      };
      const screenshot = name => page.screenshot({ path: path.join(output, `${width}x${height}-${name}.png`) });
      const inside = async locator => {
        const box = await locator.boundingBox();
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, 'control outside viewport');
      };
      const openSidebar = async () => {
        const toggle = page.getByRole('button', { name: '展开侧栏', exact: true });
        if (await toggle.count()) await toggle.click();
      };
      await page.goto(base);
      await page.getByRole('button', { name: '选择模型', exact: true }).waitFor();
      await check('home');
      if (width <= 960) {
        const toggle = page.getByRole('button', { name: '展开侧栏', exact: true });
        const box = await toggle.boundingBox();
        assert.ok(box.x < 20 && box.width >= 44 && box.height >= 44, 'mobile toolbar position / touch target');
        const input = page.locator('textarea').first();
        assert.ok(await input.evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 16), 'composer font under 16px');
        await input.fill('移动端布局测试（不发送）');
        await input.fill('');
      }
      await screenshot('home');
      await page.getByRole('button', { name: '选择模型', exact: true }).click();
      const menu = page.getByRole('menu');
      if (await menu.count()) {
        await inside(menu);
        await screenshot('model-menu');
        await page.keyboard.press('Escape');
        assert.equal(await menu.count(), 0);
        await check('model-menu');
      }
      await page.getByRole('button', { name: '打开工作区', exact: true }).click();
      await check('workspace');
      if (width <= 960) {
        const box = await page.locator('.workspace-panel').boundingBox();
        assert.equal(box.x, 0);
        assert.equal(Math.round(box.width), width);
        assert.equal(await page.locator('.inno-workspace-header-button[aria-pressed]').isVisible(), false);
        await openSidebar();
        await check('workspace-with-sidebar');
        assert.equal((await page.locator('.workspace-panel').boundingBox()).x, 0);
        await page.locator('.app-layout-scrim').click({ position: { x: width - 5, y: height / 2 } });
        await page.getByRole('button', { name: '展开侧栏', exact: true }).waitFor();
      }
      await screenshot('workspace');
      await page.getByRole('button', { name: '收起工作区', exact: true }).click();
      await openSidebar();
      await page.getByRole('button', { name: 'IA Inno Agent' }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const dialog = page.getByRole('dialog');
      for (const tab of ['通用','模型','记忆','集成','渠道','MCP','实验室','关于']) {
        await dialog.locator('aside button').filter({ hasText: tab }).click();
        await check(`settings-${tab}`);
        assert.equal(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth), true, 'settings horizontal overflow');
        await inside(dialog.getByRole('button', { name: '关闭', exact: true }));
        if (tab === '通用') await screenshot('settings');
      }
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await dialog.count(), 0);
      for (const feature of ['notebook','skills','learner','jobs']) {
        await page.goto(`${base}/?page=${feature}`);
        await page.locator('.inno-feature-header h1').waitFor();
        await check(feature);
        if (width <= 960) {
          const title = await page.locator('.inno-feature-header h1').boundingBox();
          const button = await page.getByRole('button', { name: '展开侧栏', exact: true }).boundingBox();
          assert.ok(title.x >= button.x + button.width, `${feature}: toolbar overlaps title`);
        }
        await screenshot(feature);
      }
      // Optionally exercise a known, existing long conversation without sending.
      if (process.env.MOBILE_TEST_SESSION_TITLE && width <= 960) {
        await page.goto(base);
        await openSidebar();
        await page.locator('[role="button"]').filter({ hasText: process.env.MOBILE_TEST_SESSION_TITLE }).click();
        await page.locator('.inno-conversation-header').waitFor();
        await check('existing-conversation');
        const overlapping = await page.locator('.inno-composer-toolbar').evaluate(toolbar => {
          const boxes = [...toolbar.querySelectorAll('button')].map(e => e.getBoundingClientRect()).filter(r => r.width && r.height);
          return boxes.some((a, i) => boxes.slice(i + 1).some(b => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1));
        });
        assert.equal(overlapping, false, 'composer buttons overlap');
        assert.equal(await page.locator('.chat-scroll').evaluate(e => e.scrollWidth <= e.clientWidth), true, 'conversation horizontal overflow');
        await screenshot('conversation');
      }
      // Synthetic visualViewport resize verifies the layout hook, not a real iOS keyboard.
      if (width === 390) {
        await page.goto(base);
        await openSidebar();
        await page.getByRole('button', { name: 'IA Inno Agent' }).click();
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.waitForTimeout(100);
        assert.equal(Math.round((await page.getByRole('dialog').boundingBox()).height), 360, 'settings ignores visual viewport');
        await check('synthetic-keyboard');
        await screenshot('synthetic-keyboard');
      }
      assert.deepEqual(errors, [], `${width}: runtime errors`);
      await context.close();
      console.log(`PASS ${width}x${height}`);
    }
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`PASS ${results.length} layout/interaction states; screenshots: ${output}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
