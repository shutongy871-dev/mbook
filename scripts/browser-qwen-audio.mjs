// Production extension + real local music decoding; only provider/network responses are fixtures.
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const artifacts = path.resolve('.artifacts/qwen-audio');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'profile-'));
const extension = path.resolve('.output/chrome-mv3');
const music = await readFile('public/cc0/cc01-calm.m4a');
const vector = [.2, .1, .7, .3, 0, 0, .2, 0];
const results = [];
const requests = [];
let context, page, apiCalls = 0, releaseFirst, wavInfo;
const firstReady = new Promise(resolve => { releaseFirst = resolve; });
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.MBOOK_CHROME, channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--disable-breakpad', '--disable-crash-reporter'],
  });
  context.on('request', request => requests.push(request.url()));
  context.on('requestfailed', request => console.log('request failed', request.url(), request.failure()));
  await context.route('https://music.163.com/**', route => route.fulfill({ json: { code: 200, account: null, data: [] } }));
  const qwenFixture = async route => {
    apiCalls++;
    const body = route.request().postDataJSON();
    expect(body.model).toBe('qwen3.8-omni-flash');
    expect(body.stream).toBe(true);
    expect(body.messages[1].content[0].type).toBe('input_audio');
    const bytes = Buffer.from(body.messages[1].content[0].input_audio.data.split(',')[1], 'base64');
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.readUInt32LE(24)).toBe(16000);
    expect(bytes.readUInt16LE(22)).toBe(1);
    expect(bytes.length).toBe(1920044);
    let power = 0;
    for (let offset = 44; offset < bytes.length; offset += 2) power += (bytes.readInt16LE(offset) / 32768) ** 2;
    wavInfo = { bytes: bytes.length, sampleRate: 16000, channels: 1, seconds: 60,
      rms: Math.sqrt(power / ((bytes.length - 44) / 2)) };
    expect(wavInfo.rms).toBeGreaterThan(.001);
    if (apiCalls === 1) await firstReady;
    if (apiCalls === 2) { await route.fulfill({ status: 401, body: 'fixture auth rejection' }); return; }
    const output = JSON.stringify({ segments: [0, 1, 2].map(index => ({
      index, emotion: vector, confidence: .8, evidence: '测试响应：柔和钢琴，舒缓节奏',
    })) });
    const chunks = [
      { choices: [{ delta: { reasoning_content: 'ignore this non-JSON thought' } }] },
      { choices: [{ delta: { content: output.slice(0, 80) } }] },
      { choices: [{ delta: { content: output.slice(80) }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 800, completion_tokens: 190,
        prompt_tokens_details: { audio_tokens: 420, text_tokens: 380 } } },
    ];
    await route.fulfill({ contentType: 'text/event-stream',
      body: chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n' });
  };
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  // Chrome offscreen documents are CDP "other" targets, invisible to Playwright context.route.
  // Attach Fetch interception to that actual target; no production JS is replaced.
  await worker.evaluate(async () => {
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'), reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
      justification: 'Verify production audio decoding and inference lifecycle with fixture network responses',
    });
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find(t => t.url === `chrome-extension://${id}/offscreen.html`);
  expect(target).toBeTruthy();
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let commandId = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const cid = ++commandId;
    pending.set(cid, { resolve, reject });
    void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: cid, method, params }) }).catch(reject);
  });
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(JSON.stringify(message.error)));
      else waiting?.resolve(message.result);
    }
    if (message.method === 'Fetch.requestPaused') {
      const { request, requestId } = message.params;
      const route = {
        request: () => ({ postDataJSON: () => JSON.parse(request.postData) }),
        fulfill: async ({ status = 200, body, contentType = 'text/plain' }) => send('Fetch.fulfillRequest', {
          requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: contentType },
            { name: 'Access-Control-Allow-Origin', value: '*' }],
          body: Buffer.from(body).toString('base64'),
        }),
      };
      void (request.url.startsWith('https://audio-fixture.example/')
        ? route.fulfill({ body: music, contentType: 'audio/mp4' }) : qwenFixture(route)).catch(console.error);
    }
  });
  await send('Network.enable', { maxPostDataSize: 4 * 1024 * 1024 });
  await send('Fetch.enable', { patterns: [
    { urlPattern: 'https://audio-fixture.example/*' }, { urlPattern: 'https://qwen-fixture.example/*' },
  ] });
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.locator('#model-settings')).toBeVisible();
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('mbook');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const tx = database.transaction(['songs', 'songProfiles'], 'readwrite');
      for (let i = 1; i <= 3; i++) {
        const songId = `netease:audio-${i}`;
        tx.objectStore('songs').put({
          song_id: songId, dedup_key: songId, primary_source: 'netease', source_song_id: `audio-${i}`,
          source_channels: ['netease'], title: `听感测试 ${i}`, artist: '独立测试样本', album: '测试',
          duration_sec: 72, has_lyrics: false, language: 'instrumental', bitrate_kbps: 192,
          audio_format: 'm4a', stream_url: 'https://audio-fixture.example/calm.m4a',
          url_expire_at: Date.now() + 3600_000, playable: true, copyright_available: true,
          backup_sources: [], added_at: Date.now(), first_seen_at: Date.now(), last_matched_at: 0,
          blacklisted: false, tag_version: 'emotion-8-v1', profile_status: 'audio_done',
        });
        tx.objectStore('songProfiles').put({
          song_id: songId, emotion_vector: [.9, 0, 0, 0, 0, 0, 0, 0],
          music_tags: [], semantic_text: '原元数据画像', semantic_embedding: [], audio_features: null,
          popularity_raw: 0, popularity_score: 40, platform_tags: [],
        });
      }
      tx.oncomplete = () => { database.close(); resolve(null); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  const models = page.locator('#model-settings');
  await models.getByLabel('接口地址（Base URL）').fill('https://qwen-fixture.example/compatible-mode/v1');
  await models.getByLabel('API Key', { exact: true }).fill('fixture-key-no-real-service');
  await models.getByLabel('音乐识别', { exact: true }).check();
  await page.getByRole('button', { name: '音乐画像', exact: true }).click();
  const panel = page.locator('#audio-emotion');
  await panel.getByText('批处理设置', { exact: true }).click();
  await panel.getByLabel('累计尝试上限（含失败）').fill('2');
  await expect(panel.locator('select')).toHaveCount(0);
  await expect(panel).not.toContainText('听感测试 1');
  await page.getByRole('button', { name: '记录与诊断', exact: true }).click();
  const audioDiagnostics = page.locator('#audio-diagnostics');
  await page.locator('.diagnostics-section').filter({ has: audioDiagnostics }).locator('summary').first().click();
  await expect(audioDiagnostics.locator('option[value="netease:audio-1"]')).toHaveCount(1);
  await audioDiagnostics.getByLabel('选择歌曲', { exact: true }).selectOption('netease:audio-1');
  await audioDiagnostics.getByRole('button', { name: '识别这一首' }).click();
  await expect.poll(() => apiCalls, { timeout: 20000 }).toBe(1);
  await expect(audioDiagnostics).toContainText('听感测试 1 · 独立测试样本 · 识别中');
  const paused = await page.evaluate(async () => {
    const start = performance.now();
    const result = await chrome.runtime.sendMessage({ type: 'PAUSE' });
    return { elapsed: performance.now() - start, ok: result.ok, status: result.playback.status };
  });
  expect(paused.ok).toBe(true);
  expect(paused.elapsed).toBeLessThan(1500);
  // Exercise >30s silence while audio inference is pending. No audio is played for sampling.
  await new Promise(resolve => setTimeout(resolve, 35000));
  const alive = await worker.evaluate(() => chrome.offscreen.hasDocument());
  expect(alive).toBe(true);
  releaseFirst();
  await expect(audioDiagnostics).toContainText('听感测试 1 · 独立测试样本 · 完成', { timeout: 15000 });
  await audioDiagnostics.getByText('查看识别记录（1）', { exact: true }).click();
  await audioDiagnostics.getByText('听感测试 1 · 独立测试样本 · 完成', { exact: true }).click();
  await expect(audioDiagnostics).toContainText('0.200 / 0.100 / 0.700 / 0.300');
  await expect(audioDiagnostics).toContainText('音频 420');
  const readStore = async (store, key) => page.evaluate(({ store, key }) => new Promise((resolve, reject) => {
    const r = indexedDB.open('mbook');
    r.onsuccess = () => {
      const database = r.result, t = database.transaction(store);
      const q = t.objectStore(store).get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
      t.oncomplete = () => database.close();
    };
  }), { store, key });
  const saved = await readStore('songProfiles', 'netease:audio-1');
  expect(saved.emotion_vector).toEqual(vector);
  saved.audio_emotion.segments.forEach((segment, index) =>
    expect(segment.start_sec).toBeCloseTo([0, 26, 52][index], 1)); // AAC padding adds ~30ms.
  expect(saved.audio_emotion.usage.audio_tokens).toBe(420);
  await audioDiagnostics.getByRole('button', { name: '识别这一首' }).click();
  await expect(audioDiagnostics.getByRole('status')).toContainText('已复用已有画像');
  expect(apiCalls).toBe(1);
  results.push({ name: 'Real decoded music → 16k mono WAV → mocked Qwen SSE → persisted eight-dimensional candidate profile',
    wavInfo, segments: saved.audio_emotion.segments.map(s => ({ start: s.start_sec, seconds: s.duration_sec })) });
  results.push({ name: 'Silent offscreen survives 35s inference; manual pause remains responsive; cache avoids another call', paused });
  await audioDiagnostics.getByLabel('选择歌曲', { exact: true }).selectOption('netease:audio-2');
  await audioDiagnostics.getByRole('button', { name: '识别这一首' }).click();
  await expect(audioDiagnostics).toContainText('HTTP 401', { timeout: 15000 });
  await page.getByRole('button', { name: '音乐画像', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('HTTP 401', { timeout: 15000 });
  expect((await readStore('songProfiles', 'netease:audio-2')).emotion_vector).toEqual([.9, 0, 0, 0, 0, 0, 0, 0]);
  await panel.getByRole('button', { name: '开始批处理' }).click();
  await expect(panel.getByRole('status')).toContainText('累计尝试上限');
  expect(apiCalls).toBe(2);
  // Settings/worker reopen keep the cap and profile. No hidden retry on lifecycle wake.
  await page.reload();
  await page.getByRole('button', { name: '音乐画像', exact: true }).click();
  await expect(panel).toContainText('已尝试 2 / 2');
  await page.getByRole('button', { name: '记录与诊断', exact: true }).click();
  await page.locator('.diagnostics-section').filter({ has: page.locator('.library-diagnostics') }).locator('summary').first().click();
  const diagnostics = page.locator('.library-diagnostics');
  await diagnostics.getByRole('button', { name: '刷新诊断' }).click();
  await diagnostics.locator('.reading-record').filter({ hasText: '听感测试 1' }).locator('summary').first().click();
  await expect(diagnostics).toContainText('模型听音频');
  results.push({ name: '401 pauses batch, retains old profile, counts failed attempts; UI reload preserves cap', apiCalls });
  await page.screenshot({ path: path.join(artifacts, 'options.png'), fullPage: true });
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ results, realModelInference: false }, null, 2));
  console.log(JSON.stringify(results));
} catch (error) {
  console.error(error);
  const ui = await page?.locator('#audio-emotion').textContent().catch(() => '');
  console.log(ui);
  console.log('requests', requests);
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ results, apiCalls, ui, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally { releaseFirst(); await context?.close(); }
