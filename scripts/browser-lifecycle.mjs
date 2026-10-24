import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

await mkdir('.artifacts/lifecycle', { recursive: true });
const words = ['他打开门', '有点害怕', '害怕', '非常害怕'];
const server = createServer((req, res) => {
  const n = Number(new URL(req.url, 'http://localhost').searchParams.get('scene') ?? 0);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<html><head><title>章节 ${n}</title></head><body>
    <a href="/?scene=${Math.min(n + 1, 3)}">下一章</a>
    <article style="width:650px;margin:auto;line-height:2;font-size:20px">
    <h1>章节 ${n}</h1>${Array.from({ length: 20 }, (_, i) =>
      `<p>${i} ${`${words[n]}，这里写着书中的文字，读者继续阅读这一段文字。`.repeat(7)}</p>`).join('')}
    </article></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const extension = path.resolve('.output/chrome-mv3');
const profile = await mkdtemp(path.resolve('.artifacts/lifecycle/profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.MBOOK_CHROME, channel: 'chromium', headless: true,
  ignoreDefaultArgs: ['--mute-audio'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    '--disable-breakpad', '--disable-crash-reporter'],
});
const results = [];
const started = Date.now();
const note = (name, evidence) => {
  results.push({ name, seconds: (Date.now() - started) / 1000, evidence });
  console.log(JSON.stringify(results.at(-1)));
};
let popup;
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  // Observe production messages concurrently, using the same receiving clock.
  await popup.evaluate(() => {
    globalThis.mbookTiming = { focusedAt: null, playingAt: null };
    chrome.runtime.onMessage.addListener(msg => {
      const timing = globalThis.mbookTiming;
      if (msg.type === 'READING_HEARTBEAT' && msg.state?.state === 'focused' && timing.focusedAt == null)
        timing.focusedAt = performance.now();
      if (msg.type === 'OFFSCREEN_STATE' && msg.state?.status === 'playing' && timing.playingAt == null)
        timing.playingAt = performance.now();
    });
  });
  const status = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${server.address().port}/`);
  await article.bringToFront();
  await expect.poll(async () => (await status()).playback.status, { timeout: 12000 }).toBe('playing');
  const first = await status();
  const timing = await popup.evaluate(() => globalThis.mbookTiming);
  expect(timing.focusedAt).not.toBeNull();
  expect(timing.playingAt).not.toBeNull();
  const focusedToPlaybackMs = Math.round(timing.playingAt - timing.focusedAt);
  expect(focusedToPlaybackMs).toBeGreaterThanOrEqual(0);
  expect(focusedToPlaybackMs).toBeLessThan(2000);
  note('First focused article automatically starts real audio', { playback: first.playback, focusedToPlaybackMs,
    clock: 'concurrent production heartbeat and playback messages observed on the same receiver' });
  const firstId = first.playback.trackId;
  // Move through genuinely different reading windows. Production clocks and thresholds remain unchanged.
  for (let n = 1; n <= 3; n++) {
    await article.getByRole('link', { name: '下一章' }).click();
    await expect.poll(async () => (await status()).reading?.title, { timeout: 12000 }).toBe(`章节 ${n}`);
    await expect.poll(async () => (await status()).mood?.vector?.[4], { timeout: 15000 })
      .toBeCloseTo([0, .25, .5, .75][n], 2);
    if (n === 1) {
      await expect.poll(async () => (await status()).playback.trackId, { timeout: 10000 }).not.toBe(firstId);
      expect(Date.now() - started).toBeLessThan(45000);
      note('First new analysis switches without duration or trend gates', (await status()).playback);
    }
  }
  const switched = await status();
  note('Every new reading window uses the latest eight-dimensional match', switched.playback);
  expect(switched.mood.vector).toHaveLength(8);
  expect(switched.mood).not.toHaveProperty('label');
  expect(switched.playback.trackId).toBe('cc04');
  const nextId = switched.playback.trackId;
  // Same text window is not reanalyzed; the next change must be a natural ending.
  await expect.poll(async () => (await status()).playback.trackId, { timeout: 85000, intervals: [1000] }).not.toBe(nextId);
  const ended = await status();
  expect(ended.playback.status).toBe('playing');
  expect(ended.stats.complete_rate).toBeGreaterThan(0);
  note('72-second natural ending records completion and continues audio', ended.playback);

  // Closed Shadow DOM: drag using the rendered host geometry and verify persisted coordinates.
  const host = article.locator('#mbook-floating-ball');
  const before = await host.boundingBox();
  await article.mouse.move(before.x + before.width - 77, before.y + 23);
  await article.mouse.down();
  await article.mouse.move(before.x + before.width - 237, before.y - 97, { steps: 12 });
  await article.mouse.up();
  const after = await host.boundingBox();
  expect(after.x).toBeLessThan(before.x - 100);
  expect(after.y).toBeLessThan(before.y - 70);
  expect((await status()).playback.status).toBe('playing');
  await article.reload();
  await expect.poll(async () => (await host.boundingBox())?.x, { timeout: 10000 }).toBeCloseTo(after.x, 0);
  note('Floating control drags without pausing and restores position', { x: after.x, y: after.y });

  const idleAt = Date.now();
  await popup.bringToFront();
  await expect.poll(async () => (await status()).playback.status, { timeout: 45000, intervals: [1000] }).toBe('paused');
  expect(Date.now() - idleAt).toBeGreaterThanOrEqual(29000);
  note('Inactive reading automatically pauses after 30 seconds', (await status()).playback);
  await article.bringToFront();
  await expect.poll(async () => (await status()).playback.status, { timeout: 15000 }).toBe('playing');
  note('Focused reading resumes an automatic pause', (await status()).playback);
  await popup.bringToFront();
  await popup.getByRole('button', { name: '暂停', exact: true }).click();
  const manualAt = Date.now();
  await article.bringToFront();
  await expect.poll(async () => {
    const r = (await status()).reading;
    return r?.state === 'focused' && r.updated_at > manualAt + 3000;
  }, { timeout: 12000 }).toBe(true);
  const manualPosition = (await status()).playback.positionSec;
  // A bounded real-time observation, not a fake-clock test.
  await expect.poll(async () => Date.now() - (await status()).reading.updated_at, { timeout: 5000 }).toBeLessThan(3000);
  expect((await status()).playback).toMatchObject({ status: 'paused', positionSec: manualPosition });
  note('Manual pause remains authoritative during focused reading', (await status()).playback);
  await popup.bringToFront();
  await popup.reload();
  await popup.getByLabel('手动情绪（锁定 10 分钟）').selectOption('sadness');
  await expect(popup.locator('.mood-vec span')).toHaveCount(8);
  await expect.poll(async () => (await status()).mood?.vector).toEqual([0, .8, 0, 0, 0, 0, 0, 0]);
  await expect(popup.locator('.mood-label')).toHaveCount(0);
  note('Popup exposes eight dimensions and eight manual presets', { vector: (await status()).mood.vector });
  await popup.goto(`chrome-extension://${id}/options.html`);
  await popup.getByRole('heading', { name: '阅读命中记录', exact: true }).scrollIntoViewIfNeeded();
  await expect(popup.locator('.reading-record')).not.toHaveCount(0);
  await popup.locator('.reading-record summary').first().click();
  await expect(popup.locator('.reading-record').first()).toContainText('筛选轮次');
  const rows = await popup.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('mbook');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const query = database.transaction('readingAnalyses').objectStore('readingAnalyses').getAll();
      query.onsuccess = () => { resolve(query.result); database.close(); };
    };
  }));
  expect(rows.length).toBeGreaterThanOrEqual(4);
  expect(rows.every(row => row.selectionMode === 'eight-dimensional' && row.matchingVector.length === 8)).toBe(true);
  expect(rows.some(row => row.selection.selectedId === 'cc04' && row.selection.attempts.length > 0)).toBe(true);
  note('Production reading records contain actual eight-dimensional selections', {
    count: rows.length, latest: rows.at(-1).selection,
  });
  await writeFile('.artifacts/lifecycle/results.json', JSON.stringify({ results }, null, 2));
} catch (e) {
  const status = popup ? await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' })).catch(() => null) : null;
  const contexts = popup ? await popup.evaluate(() => chrome.runtime.getContexts({})).catch(() => null) : null;
  await writeFile('.artifacts/lifecycle/results.json', JSON.stringify({ results, error: String(e), status, contexts }, null, 2));
  console.error(e, status);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}
