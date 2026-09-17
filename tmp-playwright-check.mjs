import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
console.log(await page.title());
await browser.close();
