// @ts-check
import { test } from '@playwright/test';

test('debug login page', async ({ page }) => {
  page.on('console', msg => console.log('CONSOLE:', msg.type(), msg.text().slice(0, 300)));
  page.on('pageerror', err => console.log('PAGEERROR:', err.message.slice(0, 500)));
  await page.goto('http://localhost:5173/#/');
  await page.waitForTimeout(15000);
  console.log('URL:', page.url());
  const body = await page.locator('body').innerText();
  console.log('BODY LEN:', body.length);
  console.log('BODY:', body.slice(0, 1000));
  await page.screenshot({ path: 'login-debug.png', fullPage: true });
});
