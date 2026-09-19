// Temporary diagnostic: reproduce the live login flow in a real browser.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });

page.on('console', (msg) => console.log(`[console:${msg.type()}] ${msg.text()}`));
page.on('requestfailed', (req) => console.log(`[requestfailed] ${req.method()} ${req.url()} -> ${req.failure()?.errorText}`));
page.on('response', (res) => {
  if (res.url().includes('/api/')) console.log(`[response] ${res.status()} ${res.request().method()} ${res.url()}`);
});

await page.goto('https://qwerty9yh-gif.github.io/LS/', { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait for either the login form or the app
await page.waitForTimeout(4000);
const hasForm = await page.locator('#login-form').count();
const hasApp = await page.locator('.app').count();
console.log(`state: login-form=${hasForm} app=${hasApp}`);

if (hasForm) {
  await page.fill('#login-email', 'qwerty@gmail.com');
  await page.fill('#login-password', '123456789');
  await page.click('.login-btn');
  await page.waitForTimeout(9000);
  const err = await page.locator('#login-error').textContent().catch(() => '');
  const errVisible = await page.locator('#login-error').isVisible().catch(() => false);
  const appAfter = await page.locator('.app').count();
  const topbar = await page.locator('.topbar h1').textContent().catch(() => '');
  console.log(`after submit: errorVisible=${errVisible} error="${err}" appRendered=${appAfter} topbar="${topbar}"`);
  const auth = await page.evaluate(() => localStorage.getItem('laundry-auth-v1'));
  console.log(`auth flag: ${auth}`);
}

await page.screenshot({ path: 'tmp-login-check.png', fullPage: true });
await browser.close();
console.log('DONE');
