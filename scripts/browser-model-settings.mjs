import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const artifacts = path.resolve('.artifacts/model-settings');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'profile-'));
const extension = path.resolve('.output/chrome-mv3');
const vector = [.81, .02, .13, .24, .35, .46, .57, .68];
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<title>模型识别测试${req.url}</title><article style="width:650px;margin:auto;font-size:20px;line-height:2">
    <h1>模型识别测试${req.url}</h1>${Array.from({ length: 10 }, () =>
      `<p>${'他非常悲伤，继续阅读这一段文字，记录书中的内容。'.repeat(8)}</p>`).join('')}</article>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context, page, mode = 'ok', apiCalls = 0, release;
const gate = new Promise(resolve => { release = resolve; });
const results = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.MBOOK_CHROME, channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--disable-breakpad', '--disable-crash-reporter'],
  });
  await context.route('https://music.163.com/**', route => route.fulfill({ json: { code: 200, account: null, data: [] } }));
  await context.route('https://shared-model.example/**', async route => {
    apiCalls++;
    const request = route.request().postDataJSON();
    expect(request.model).toBe('qwen3.8-omni-flash');
    expect(request.stream).toBe(true);
    expect(typeof request.messages[1].content).toBe('string');
    expect(request).not.toHaveProperty('response_format');
    await gate;
    if (mode === 'fail') { await route.fulfill({ status: 401, body: 'fixture auth error' }); return; }
    const content = JSON.stringify({ emotion: vector, confidence: .9, evidence: '测试响应：按上下文判断情绪' });
    await route.fulfill({ contentType: 'text/event-stream', body: [
      'data: {"choices":[{"delta":{"reasoning_content":"Ignore this reasoning"}}]}',
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}`,
      'data: [DONE]',
    ].join('\n\n') });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.locator('#model-settings')).toBeVisible();
  // Fixture the previous version's actual storage shape; migration must happen through production code.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('mbook');
    req.onsuccess = () => {
      const database = req.result;
      const tx = database.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ key: 'app', value: {
        models: [
          { id: 'old-text', name: '', endpoint: 'https://shared-model.example/compatible-mode/v1',
            api_key: 'unused-old-key', model: 'Qwen3.8-Omni-Flash' },
          { id: 'working-audio', name: '', endpoint: 'https://shared-model.example/compatible-mode/v1',
            api_key: 'fixture-secret', model: 'qwen3.8-omni-flash' },
        ], text_model_id: null, music_model_id: 'working-audio', autoplay: false,
      } });
      tx.oncomplete = () => { database.close(); resolve(null); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  const models = page.locator('#model-settings');
  await expect(models.getByLabel('模型名', { exact: true })).toHaveCount(1);
  await expect(models.getByLabel('模型名', { exact: true })).toHaveValue('qwen3.8-omni-flash');
  await expect(models.getByLabel('文字识别', { exact: true })).not.toBeChecked();
  await expect(models.getByLabel('音乐识别', { exact: true })).toBeChecked();
  await expect(models.locator('select')).toHaveCount(0);
  await expect(models.getByRole('button', { name: '添加模型' })).toHaveCount(0);
  await expect(page.getByText('AI 强度', { exact: true })).toHaveCount(0);
  await expect(page.getByText('阅读识别记录', { exact: true })).not.toBeVisible();
  await page.setViewportSize({ width: 480, height: 860 });
  await page.screenshot({ path: path.join(artifacts, 'settings-compact.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  results.push({ name: 'Duplicate model rows collapse to one form and two checkboxes; 480px layout has no overflow' });
  // First observe the real content script's dictionary route, while no text model is assigned.
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${server.address().port}/dictionary`);
  const status = () => page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
  await expect.poll(async () => (await status()).text_analysis, { timeout: 15000 })
    .toMatchObject({ source: 'dictionary', status: 'complete' });
  await expect.poll(async () => (await status()).mood?.vector).toEqual([0, .75, 0, 0, 0, 0, 0, 0]);
  expect(apiCalls).toBe(0);
  await page.bringToFront();
  await models.getByLabel('文字识别', { exact: true }).check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存');
  const storage = await page.evaluate(() => new Promise(resolve => {
    const r = indexedDB.open('mbook');
    r.onsuccess = () => {
      const d = r.result, q = d.transaction('settings').objectStore('settings').get('app');
      q.onsuccess = () => { const s = q.result.value; resolve({
        count: s.models.length, text: s.text_model_id, music: s.music_model_id,
        legacyKeysEmpty: !s.llm_key && !s.song_audio_key,
      }); d.close(); };
    };
  }));
  expect(storage).toEqual({ count: 1, text: 'working-audio', music: 'working-audio', legacyKeysEmpty: true });
  await article.bringToFront();
  await article.goto(`http://127.0.0.1:${server.address().port}/model`);
  await expect.poll(() => apiCalls, { timeout: 15000 }).toBe(1);
  await expect.poll(async () => (await status()).text_analysis.status).toBe('pending');
  const before = (await status()).mood.vector;
  expect(before).toEqual([0, .75, 0, 0, 0, 0, 0, 0]);
  release();
  await expect.poll(async () => (await status()).mood?.vector, { timeout: 15000 }).toEqual(vector);
  results.push({ name: 'Unassigned text uses dictionary; one shared model assigned to both tasks; streamed scores applied exactly', storage, vector });
  mode = 'fail';
  await article.goto(`http://127.0.0.1:${server.address().port}/failure`);
  await expect.poll(async () => (await status()).text_analysis.status, { timeout: 15000 }).toBe('failed');
  expect((await status()).mood.vector).toEqual(vector);
  const callsAfterFailure = apiCalls;
  await page.bringToFront();
  await page.getByRole('button', { name: '记录与诊断', exact: true }).click();
  await page.getByText('阅读识别记录', { exact: true }).click();
  await expect(page.getByText('失败 1', { exact: true })).toBeVisible();
  await page.locator('.reading-record').first().locator('summary').click();
  await expect(page.locator('.reading-record').first()).toContainText('LLM HTTP 401');
  await expect(page.locator('.reading-record').first()).not.toContainText('词条命中');
  await page.screenshot({ path: path.join(artifacts, 'records.png'), fullPage: true });
  results.push({ name: '401 produces model failure record without fake zero/dictionary result', apiCalls: callsAfterFailure });
  await page.getByRole('button', { name: '常用设置', exact: true }).click();
  await models.getByLabel('文字识别', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await article.bringToFront();
  await article.goto(`http://127.0.0.1:${server.address().port}/dictionary-again`);
  await expect.poll(async () => (await status()).text_analysis, { timeout: 15000 })
    .toMatchObject({ source: 'dictionary', status: 'complete' });
  expect((await status()).mood.vector).toEqual([0, .75, 0, 0, 0, 0, 0, 0]);
  expect(apiCalls).toBe(callsAfterFailure);
  await page.bringToFront();
  await page.reload();
  await expect(models.getByLabel('文字识别', { exact: true })).not.toBeChecked();
  await expect(models.getByLabel('音乐识别', { exact: true })).toBeChecked();
  await expect(models.getByLabel('模型名', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '音乐画像', exact: true }).click();
  await expect(page.locator('#audio-emotion select')).toHaveCount(0);
  await expect(page.getByText(/查看识别记录/)).toHaveCount(0);
  await page.screenshot({ path: path.join(artifacts, 'music-progress.png') });
  await page.getByRole('button', { name: '记录与诊断', exact: true }).click();
  const audioDiagnostics = page.locator('.diagnostics-section').filter({ has: page.locator('#audio-diagnostics') });
  await expect(page.locator('#audio-diagnostics')).not.toBeVisible();
  await audioDiagnostics.locator('summary').first().click();
  await expect(page.locator('#audio-diagnostics').getByLabel('选择歌曲')).toBeVisible();
  results.push({ name: 'Song picker and individual records appear only in the collapsed music diagnostics section' });
  results.push({ name: 'Unassigning text restores dictionary without losing music assignment or shared configuration' });
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ results, realModelInference: false }, null, 2));
  console.log(JSON.stringify(results));
} catch (error) {
  console.error(error);
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ results, apiCalls, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally { release(); await context?.close(); server.close(); }
