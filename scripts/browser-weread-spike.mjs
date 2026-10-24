import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
await mkdir('.artifacts/weread', { recursive: true });
const profile = await mkdtemp(path.resolve('.artifacts/weread/profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.MBOOK_CHROME, channel: 'chromium', headless: true,
  args: ['--disable-breakpad', '--disable-crash-reporter'],
});
try {
  // Observe only text passed to the normal canvas renderer. No API decryption or account access.
  await context.addInitScript(() => {
    window.__mbookDraws = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (window.__mbookDraws.length < 2000) window.__mbookDraws.push({
        text: String(args[0]), x: args[1], y: args[2], canvas: this.canvas.className,
        parent: this.canvas.parentElement?.className,
      });
      return original.apply(this, args);
    };
  });
  const page = await context.newPage();
  await page.goto('https://weread.qq.com/web/reader/ada325807168230aada7458k5423294025b54229abfc040', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__mbookDraws.length > 10, { timeout: 25000 }).catch(() => {});
  const result = await page.evaluate(() => ({
    url: location.href, title: document.title, text: document.body.innerText.slice(0,800),
    draws: window.__mbookDraws.slice(0,60), count: window.__mbookDraws.length,
    canvases: [...document.querySelectorAll('canvas')].map(e => ({ rect: e.getBoundingClientRect().toJSON(), parent: e.parentElement?.className })),
  }));
  await writeFile('.artifacts/weread/spike.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await context.close(); }
