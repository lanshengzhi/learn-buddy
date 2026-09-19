const pw = require('/home/lansy/.local/share/mise/installs/npm-playwright/1.62.1/lib/node_modules/playwright');
(async () => {
  const browser = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log('CONSOLE[' + m.type() + ']:', m.text()));
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'networkidle' });
  await page.click('.gate-choice');
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  await page.click('#empty-library-btn');
  await page.waitForSelector('#library-overlay:not([hidden])');
  await page.locator('.library-entry').first().click();
  await page.waitForFunction(() => document.body.dataset.view === 'book');
  await page.waitForSelector('#chapter-body .sent');
  await page.locator('#chapter-body .sent').nth(1).click();
  await page.waitForTimeout(600);
  await browser.close();
})();
