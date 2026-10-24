import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
await mkdir('.artifacts/browser', { recursive: true });
let hangingRequests = 0;
const server = createServer((request, response) => {
  if (request.url === '/hang') { hangingRequests++; return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<html><head><title>阅读验收文章</title></head><body><article style="width:650px;margin:auto;line-height:2;font-size:20px">
  <h1>阅读验收文章</h1>${Array.from({ length: 30 }, (_, i) => `<p>${i + 1} ${'窗外微风轻拂，他安静地坐在桌边，享受平静而温暖的午后。'.repeat(6)}</p>`).join('')}</article></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const extension = path.join(root, '.output/chrome-mv3');
const profile = await mkdtemp(path.join(root, '.artifacts/browser/profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.MBOOK_CHROME,
  channel: 'chromium',
  headless: true,
  ignoreDefaultArgs: ['--mute-audio'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    '--disable-breakpad', '--disable-crash-reporter', `--crash-dumps-dir=${path.join(root, '.artifacts/browser/crashes')}`],
});
const results = [];
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  worker.on('console', message => {
    if (message.type() === 'warning' || message.type() === 'error') console.error('SW', message.text());
  });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const popupStarted = performance.now();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await expect(page.getByText('MBook', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '已开启', exact: true })).toBeVisible();
  await expect(page.getByText('网易曲库：0 首已入库 · 0 首取流探测通过（完整播放仍需验证）', { exact: true })).toBeVisible({ timeout: 3000 });
  const initialStatusMs = Math.round(performance.now() - popupStarted);
  const sourceStatus = await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })).source_status);
  expect(sourceStatus).toMatchObject({ library_count: 0, playable_count: 0 });
  results.push({ name: 'Popup library/probe counts match committed IndexedDB on a fresh profile', initialStatusMs });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('.np-text')).toContainText('正在播放', { timeout: 10000 });
  const first = await page.locator('.np-text').textContent();
  await page.getByRole('button', { name: '换一首', exact: true }).click();
  await expect(page.locator('.np-text')).not.toHaveText(first);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.locator('.np-text')).toContainText('已暂停');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('.np-text')).toContainText('正在播放');
  await page.locator('select').selectOption('solemnity');
  await expect(page.getByText(/锁定剩余/)).toBeVisible();
  await page.getByRole('button', { name: '恢复自动', exact: true }).click();
  await expect(page.getByText(/锁定剩余/)).toHaveCount(0);
  await expect(page.locator('select')).toHaveValue('');
  results.push('Popup manual play/next/pause/resume/mood lock and unlock');
  // Controlled fixture in the production database, real HTTP media request and SW queue.
  await page.evaluate(async url => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('mbook');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction(['songs', 'songProfiles'], 'readwrite');
    const songId = 'netease:control-probe';
    tx.objectStore('songs').put({
      song_id: songId, dedup_key: songId, primary_source: 'netease', source_song_id: 'control-probe',
      title: 'Controlled pending audio', artist: 'Test fixture', album: '', duration_sec: 120,
      has_lyrics: false, language: 'instrumental', bitrate_kbps: 192, audio_format: 'aac',
      popularity_raw: 0, stream_url: url, url_expire_at: Date.now() + 3600000,
      playable: true, copyright_available: true, backup_sources: [], source_channels: ['netease'],
      blacklisted: false, added_at: Date.now(), first_seen_at: Date.now(), last_matched_at: 0,
      tag_version: 'emotion-8-v1', profile_status: 'audio_done',
    });
    tx.objectStore('songProfiles').put({
      song_id: songId, emotion_vector: [0, 0, 0, 0, 0, 0, 0, .8],
      music_tags: [], semantic_text: '', semantic_embedding: [], audio_features: null,
      popularity_raw: 0, popularity_score: 40, platform_tags: [],
    });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    database.close();
  }, `http://127.0.0.1:${server.address().port}/hang`);
  const inFlight = page.evaluate(() => chrome.runtime.sendMessage({ type: 'PLAY', trackId: 'netease:control-probe' }));
  await expect.poll(() => hangingRequests).toBeGreaterThan(0);
  const pauseStarted = performance.now();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.locator('.np-text')).toContainText('已暂停', { timeout: 1500 });
  const pauseMs = Math.round(performance.now() - pauseStarted);
  const cancelledStatus = await inFlight;
  expect(cancelledStatus.playback.trackId).not.toBe('netease:control-probe');
  const finalPause = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
  expect(finalPause.playback.status).toBe('paused');
  results.push({ name: 'Manual pause interrupts a real pending HTTP stream through the production worker', pauseMs });
  await page.evaluate(async () => {
    const database = await new Promise(resolve => {
      const request = indexedDB.open('mbook');
      request.onsuccess = () => resolve(request.result);
    });
    const tx = database.transaction(['songs', 'songProfiles'], 'readwrite');
    tx.objectStore('songs').delete('netease:control-probe');
    tx.objectStore('songProfiles').delete('netease:control-probe');
    await new Promise(resolve => { tx.oncomplete = resolve; });
    database.close();
  });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('.np-text')).toContainText('正在播放');
  await page.screenshot({ path: '.artifacts/browser/popup.png', fullPage: true });

  await page.goto(`chrome-extension://${id}/options.html`);
  const volume = page.getByLabel(/音量/);
  await volume.fill('23');
  const windowSize = page.getByLabel(/窗口字数/);
  await windowSize.fill('150');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('✓ 已保存并同步')).toBeVisible();
  expect(await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })).playback.volume)).toBe(23);
  expect(await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_BALL_STATE' })).readingSettings.window_size)).toBe(150);
  await page.reload();
  await expect(volume).toHaveValue('23');
  await expect(windowSize).toHaveValue('150');
  results.push('Options save survives reload');
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(windowSize).toHaveValue('300');
  await expect(volume).toHaveValue('40');
  expect(await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })).playback.volume)).toBe(40);
  results.push('Options reset updates consumers');
  await page.screenshot({ path: '.artifacts/browser/options.png', fullPage: true });

  await page.goto(`chrome-extension://${id}/popup.html`);
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${server.address().port}/`);
  await article.bringToFront();
  await expect(article.locator('#mbook-floating-ball')).toBeAttached();
  // Background popup polling displays the active article's latest heartbeat.
  await expect(page.locator('.rs-focused')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.reading-name')).toContainText('阅读验收文章');
  await expect(page.locator('.np-text')).toContainText('正在播放');
  results.push('Real content script → focused reading heartbeat with ongoing playback');
  await page.bringToFront();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const saved = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
  // Controlled failure injection: simulate Chrome reclaiming the production offscreen document.
  await page.evaluate(() => chrome.offscreen.closeDocument());
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('.np-text')).toContainText('正在播放');
  const recovered = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
  expect(recovered.playback.trackId).toBe(saved.playback.trackId);
  expect(recovered.playback.positionSec).toBeGreaterThanOrEqual(saved.playback.positionSec - .2);
  results.push('Production offscreen recreation resumes the same track at saved position');
  await article.screenshot({ path: '.artifacts/browser/reading.png' });
  expect(errors).toEqual([]);
  await writeFile('.artifacts/browser/results.json', JSON.stringify({ results, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ extensionId: id, results, pageErrors: errors }, null, 2));
} catch (error) {
  console.error(error);
  const diagnostics = [];
  for (const page of context.pages()) {
    diagnostics.push({ url: page.url(), text: await page.locator('.np-text').textContent({ timeout: 500 }).catch(() => null),
      playback: page.url().startsWith('chrome-extension:') ? await page.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_STATUS' })).catch(() => null) : null });
  }
  await writeFile('.artifacts/browser/results.json', JSON.stringify({ results, error: String(error), diagnostics }, null, 2));
  console.log(JSON.stringify(diagnostics));
  process.exitCode = 1;
} finally {
  await context.close();
  server.closeAllConnections();
  server.close();
}
