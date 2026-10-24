import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const artifacts = path.resolve('.artifacts/library-diagnostics');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'profile-'));
const extension = path.resolve('.output/chrome-mv3');
let context;
const results = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.MBOOK_CHROME, channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--disable-breakpad', '--disable-crash-reporter'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.getByRole('button', { name: '记录与诊断', exact: true }).click();
  await page.locator('.diagnostics-section').filter({ has: page.locator('.library-diagnostics') }).locator('summary').first().click();
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: '网易云曲库诊断' }) });
  await expect(panel.getByText('入库 0', { exact: true })).toBeVisible();
  // 独立测试浏览器中写入确定的样本，验证生产打包 UI；不使用用户曲库。
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('mbook');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const tx = database.transaction(['songs', 'songProfiles'], 'readwrite');
      const songs = tx.objectStore('songs');
      const profiles = tx.objectStore('songProfiles');
      for (let i = 0; i < 30; i++) {
        const songId = `netease:fixture-${i}`;
        songs.put({
          song_id: songId, dedup_key: songId, primary_source: 'netease',
          source_song_id: `fixture-${i}`, source_channels: ['netease'],
          title: `测试歌曲${String(i).padStart(2, '0')}`, artist: '诊断歌手', album: '测试专辑',
          duration_sec: 120, has_lyrics: i === 2, language: 'zh', bitrate_kbps: 192,
          audio_format: 'aac', stream_url: '', url_expire_at: 0, playable: i !== 3,
          copyright_available: true, backup_sources: [], added_at: Date.now(),
          first_seen_at: Date.now(), last_matched_at: 0, blacklisted: i === 4,
          tag_version: 'emotion-8-v1', last_tag_attempt: Date.now(),
          profile_status: i === 0 ? 'pending' : 'audio_done',
        });
        profiles.put({
          song_id: songId, emotion_vector: i === 1 ? null : [.5, 0, 0, 0, 0, 0, 0, 0],
          music_tags: [], semantic_text: '', semantic_embedding: [], audio_features: null,
          popularity_raw: 0, popularity_score: 50, platform_tags: [],
        });
      }
      tx.oncomplete = () => { database.close(); resolve(null); };
      tx.onerror = () => { database.close(); reject(tx.error); };
    };
  }));
  await panel.getByRole('button', { name: '刷新诊断', exact: true }).click();
  for (const label of ['入库 30', '有阻挡（去重）5', '待画像 1', '无有效画像 1', '人声过滤 1', '不可播 1', '可参与匹配 25']) {
    await expect(panel.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(panel.locator('.reading-record')).toHaveCount(20);
  await panel.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(panel.locator('.reading-record')).toHaveCount(10);
  await panel.getByLabel('筛选原因').selectOption('vocals');
  await expect(panel.locator('.reading-record')).toHaveCount(1);
  await panel.locator('summary').click();
  await expect(panel.locator('.reading-record')).toContainText('未实测，按歌词标记估算');
  await panel.getByLabel('搜索歌曲').fill('不存在的歌曲');
  await expect(panel.getByText('没有符合筛选条件的歌曲。', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: '导出全部逐首原因 JSON' }).click();
  const download = await downloadPromise;
  const exportPath = path.join(artifacts, 'export.json');
  await download.saveAs(exportPath);
  const data = JSON.parse(await readFile(exportPath, 'utf8'));
  expect(data.total).toBe(30);
  expect(data.rows).toHaveLength(30);
  expect(data.counts).toMatchObject({ pending: 1, invalid_profile: 1, vocals: 1, unplayable: 1, eligible: 25 });
  expect(data.rows.find(row => row.id === 'netease:fixture-2').reasons[0].code).toBe('vocal_density');
  results.push({ name: 'Production options UI: counts, pagination, reasons, search, full export', counts: data.counts });
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ results }, null, 2));
  console.log(JSON.stringify(results));
} catch (error) {
  console.error(error);
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ results, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await context?.close();
}
