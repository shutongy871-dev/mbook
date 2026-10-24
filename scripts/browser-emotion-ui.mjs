import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

await mkdir('.artifacts/emotion-ui', { recursive: true });
const profile = await mkdtemp(path.resolve('.artifacts/emotion-ui/profile-'));
const extension = path.resolve('.output/chrome-mv3');
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<title>八维实际阅读测试</title><article style="width:650px;margin:auto;font-size:20px;line-height:2">
    <h1>八维实际阅读测试</h1>${Array.from({ length: 10 }, () =>
      `<p>${'他非常悲伤，继续阅读这一段文字，记录书中的内容。'.repeat(8)}</p>`).join('')}</article>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const launch = () => chromium.launchPersistentContext(profile, {
  executablePath: process.env.MBOOK_CHROME, channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    '--disable-breakpad', '--disable-crash-reporter'],
});
let context;
const results = [];
const note = (name, evidence) => { results.push({ name, evidence }); console.log(JSON.stringify(results.at(-1))); };
try {
  context = await launch();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  let popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const status = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
  await popup.getByRole('button', { name: /静谧铺垫/ }).click();
  await expect.poll(async () => (await status()).playback.trackId).toBe('cc01');
  const startedPlaying = Date.now();
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${server.address().port}`);
  await expect.poll(async () => (await status()).mood?.vector, { timeout: 15000 })
    .toEqual([0, .75, 0, 0, 0, 0, 0, 0]);
  await expect.poll(async () => (await status()).playback.trackId, { timeout: 10000 }).toBe('cc03');
  expect(Date.now() - startedPlaying).toBeLessThan(30000);
  note('First reading window switches real audio without duration, interval or trend gates',
    { elapsedMs: Date.now() - startedPlaying, playback: (await status()).playback });
  await popup.bringToFront();
  await popup.reload();
  await expect(popup.locator('.mood-vec span')).toHaveCount(8);
  await expect(popup.locator('.mood-label')).toHaveCount(0);
  expect((await status()).mood).not.toHaveProperty('label');
  const ballState = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_BALL_STATE' }));
  expect(ballState).not.toHaveProperty('mood');
  note('Opening popup preserves the actual reading vector', (await status()).mood);
  const select = popup.getByLabel('手动情绪（锁定 10 分钟）');
  await expect(select.locator('option')).toHaveCount(9);
  await select.selectOption('hope');
  await expect.poll(async () => (await status()).mood?.vector).toEqual([0, 0, 0, .8, 0, 0, 0, 0]);
  await expect(select).toHaveValue('hope');
  await popup.getByRole('button', { name: '恢复自动', exact: true }).click();
  expect((await status()).manual_mood_until).toBe(0);
  note('Eight manual presets lock and restore automatic understanding', {});
  await popup.goto(`chrome-extension://${id}/options.html`);
  await popup.getByRole('button', { name: '记录与诊断', exact: true }).click();
  await popup.getByText('阅读识别记录', { exact: true }).click();
  await expect(popup.getByText('切歌分数门槛', { exact: false })).toHaveCount(0);
  await expect(popup.getByText('最小切歌间隔', { exact: false })).toHaveCount(0);
  await expect(popup.locator('.reading-record')).not.toHaveCount(0);
  await popup.locator('.reading-record summary').first().click();
  await expect(popup.locator('.reading-record').first()).toContainText('筛选轮次');
  await expect(popup.locator('.reading-record').first()).toContainText('淡淡忧伤');
  const readRecords = () => popup.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('mbook');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const query = database.transaction('readingAnalyses').objectStore('readingAnalyses').getAll();
      query.onsuccess = () => { resolve(query.result); database.close(); };
    };
  }));
  const rows = await readRecords();
  expect(rows.every(row => row.selectionMode === 'eight-dimensional' &&
    row.matchingVector.length === 8 && row.selection)).toBe(true);
  expect(rows[0].selection.selectedId).toBe('cc03');
  note('Stored evidence uses the same vector and actual selector result', {
    count: rows.length, vector: rows[0].matchingVector, selection: rows[0].selection,
  });
  await context.close();
  context = await launch();
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/options.html`);
  await popup.getByRole('button', { name: '记录与诊断', exact: true }).click();
  await popup.getByText('阅读识别记录', { exact: true }).click();
  await expect(popup.locator('.reading-record')).toHaveCount(rows.length);
  expect(await readRecords()).toEqual(rows);
  note('Full browser restart preserves reading evidence and selection', { count: rows.length });
  await writeFile('.artifacts/emotion-ui/results.json', JSON.stringify({ results }, null, 2));
} catch (error) {
  await writeFile('.artifacts/emotion-ui/results.json', JSON.stringify({ results, error: String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  server.close();
}
