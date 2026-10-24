import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
await mkdir('.artifacts/acceptance', { recursive: true });
const profile = await mkdtemp(path.resolve('.artifacts/acceptance/profile-'));
const extension = path.resolve('.output/chrome-mv3');
const launch = () => chromium.launchPersistentContext(profile, {
  executablePath: process.env.MBOOK_CHROME, channel: 'chromium', headless: true,
  ignoreDefaultArgs: ['--mute-audio'],
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
  const protectedStatus = await status();
  expect(protectedStatus.storage_protected).toBe(true);
  note('Storage protection reflects actual Chrome permission', {
    persisted: protectedStatus.persisted, storage_protected: protectedStatus.storage_protected,
  });
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: { base_volume: 23, netease_enabled: false } }));
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'LIKE_TRACK', trackId: 'cc01' }));
  const eventCount = (await status()).stats.event_count;
  await context.close();
  context = await launch();
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/options.html`);
  await expect(popup.getByLabel(/音量/)).toHaveValue('23');
  expect((await status()).stats.event_count).toBe(eventCount);
  note('Full browser close/reopen retains IndexedDB settings and feedback', { eventCount, volume: 23 });

  await popup.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(popup.getByRole('status')).toContainText('请填写 API Key');
  note('AI diagnostics offers a usable missing-configuration result', {});
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const reader = await context.newPage();
  const started = performance.now();
  await reader.goto('https://weread.qq.com/web/reader/ada325807168230aada7458k5423294025b54229abfc040', { waitUntil: 'domcontentloaded' });
  await reader.bringToFront();
  await expect.poll(async () => (await status()).reading?.extractor, { timeout: 25000 }).toBe('weread-canvas');
  await expect.poll(async () => (await status()).reading?.state, { timeout: 15000 }).toBe('focused');
  const focusedAt = performance.now();
  await expect.poll(async () => (await status()).playback.status, { timeout: 10000 }).toBe('playing');
  const first = await status();
  const windowId = first.reading.window_id;
  expect(first.reading.chapter).toBe('致中国读者的一封信');
  expect(first.reading.visible_text_len).toBeGreaterThan(100);
  note('Real WeRead chapter canvas triggers focused reading and playback', {
    url: first.reading.url, extractor: first.reading.extractor, chapter: first.reading.chapter,
    paragraphs: first.reading.paragraph_count, chars: first.reading.visible_text_len,
    navigation_to_focused_ms: Math.round(focusedAt - started),
    focused_to_observed_playing_ms: Math.round(performance.now() - focusedAt),
    playback: first.playback,
  });
  await reader.screenshot({ path: '.artifacts/acceptance/weread-chapter.png' });
  await reader.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(async () => {
    const reading = (await status()).reading;
    return reading?.extractor === 'weread-canvas' && reading.window_id && reading.window_id !== windowId;
  }, { timeout: 20000 }).toBeTruthy();
  const second = (await status()).reading;
  note('Real page turn replaces the visible text window', { old: windowId, next: second.window_id, chars: second.visible_text_len });
  await reader.screenshot({ path: '.artifacts/acceptance/weread-next.png' });

  // The same chapter is one tall canvas in vertical mode. Wait for both the site
  // and a fresh heartbeat so a stale horizontal-mode result cannot pass this check.
  await reader.locator('button.isHorizontalReader').click();
  await expect(reader.locator('button.isHorizontalReader')).toHaveCount(0);
  await expect(reader.locator('.readerChapterContentLoading')).toHaveCount(0, { timeout: 20000 });
  await expect(reader.locator('.wr_canvasContainer canvas').first()).toBeVisible();
  const switchedAt = Date.now();
  await expect.poll(async () => {
    const s = await status();
    return s.reading?.updated_at > switchedAt + 3000 && s.reading.extractor === 'weread-canvas' &&
      s.reading.state === 'focused' && s.reading.visible_text_len > 80;
  }, { timeout: 15000 }).toBe(true);
  const vertical = (await status()).reading;
  const canvasHeight = await reader.locator('.wr_canvasContainer canvas').first().evaluate(e => e.getBoundingClientRect().height);
  expect(canvasHeight).toBeGreaterThan(reader.viewportSize().height);
  note('Tall scrolling canvas recognizes visible rows without requiring half the chapter on screen', {
    paragraphs: vertical.paragraph_count, chars: vertical.visible_text_len,
    canvasHeight, viewportHeight: reader.viewportSize().height, state: vertical.state,
  });
  const scrolledAt = Date.now();
  await reader.mouse.wheel(0, 400);
  await expect.poll(async () => {
    const r = (await status()).reading;
    return r?.updated_at > scrolledAt && r.visible_text_len > 80 &&
      r.window_id && r.window_id !== vertical.window_id;
  }, { timeout: 10000 }).toBeTruthy();
  const scrolled = (await status()).reading;
  note('Vertical scroll updates the visible text window', {
    old: vertical.window_id, next: scrolled.window_id, chars: scrolled.visible_text_len,
  });
  await writeFile('.artifacts/acceptance/results.json', JSON.stringify({ results }, null, 2));
} catch (e) {
  await writeFile('.artifacts/acceptance/results.json', JSON.stringify({ results, error: String(e) }, null, 2));
  console.error(e);
  process.exitCode = 1;
} finally { await context?.close(); }
