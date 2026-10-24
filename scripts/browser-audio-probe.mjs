// Controlled local CDN faults, production AudioEngine with messaging-only stub.
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const out = path.resolve('.artifacts/audio-probe');
await mkdir(out, { recursive: true });
const extension = path.join(out, 'extension');
await cp('.output/chrome-mv3', extension, { recursive: true });
await build({ configFile: false, resolve: { alias: { '@': root, 'wxt/browser': path.resolve('scripts/probe-messaging.ts') } },
  build: { outDir: extension, emptyOutDir: false, lib: {
    entry: path.resolve('scripts/audio-probe.ts'), formats: ['es'], fileName: () => 'audio-probe.js',
  } } });
await writeFile(path.join(extension, 'probe.html'), `<!doctype html><meta charset="utf-8"><title>Audio probe</title>
  <button data-mode="ok">正常音频</button><button data-mode="cors">无 CORS 音频</button>
  <button data-mode="hang">超时音频</button><button data-mode="bad">损坏音频</button>
  <button data-mode="latecors">延迟 CORS 音频</button><button data-mode="pause">暂停</button>
  <pre></pre><pre id="pause-result"></pre><output></output><script type="module" src="./audio-probe.js"></script>`);
const data = await readFile('public/cc0/cc01-calm.m4a');
const html = await readFile(path.join(extension, 'probe.html'));
const js = await readFile(path.join(extension, 'audio-probe.js'));
const requests = [];
const server = createServer((req, res) => {
  requests.push({ url: req.url, origin: req.headers.origin ?? null, at: Date.now() });
  if (req.url === '/hang') return;
  if (req.url === '/latecors') {
    if (req.headers.origin) setTimeout(() => { res.setHeader('Content-Type', 'audio/mp4'); res.end(data); }, 2500);
    return;
  }
  if (req.url !== '/cors') res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'audio/mp4');
  if (req.url === '/bad') { res.end('corrupt audio'); return; }
  res.end(data);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const uiServer = createServer((req, res) => {
  res.setHeader('Content-Type', req.url?.startsWith('/audio-probe.js') ? 'application/javascript' : 'text/html');
  res.end(req.url?.startsWith('/audio-probe.js') ? js : html);
});
await new Promise(resolve => uiServer.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(path.join(out, 'profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.MBOOK_CHROME, channel: 'chromium', headless: true,
  ignoreDefaultArgs: ['--mute-audio'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const results = [];
try {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${uiServer.address().port}/probe.html?origin=http://127.0.0.1:${server.address().port}`);
  const play = async name => {
    const before = await page.locator('pre').first().textContent();
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('pre').first()).not.toHaveText(before, { timeout: 10000 });
    return JSON.parse(await page.locator('pre').first().textContent());
  };
  const normal = await play('正常音频');
  expect(normal.ok).toBe(true);
  expect(normal.media_start_ms).toBeGreaterThanOrEqual(0);
  results.push({ name: 'Real playing event measured from user action; local audio only', normal });
  const cors = await play('无 CORS 音频');
  expect(cors.ok).toBe(true);
  const calls = requests.filter(r => r.url === '/cors');
  expect(calls.some(r => r.origin)).toBe(true);
  expect(calls.some(r => !r.origin)).toBe(true);
  results.push({ name: 'Anonymous CORS rejection retries on a fresh native audio element', cors, requests: calls });
  const timed = await play('超时音频');
  expect(timed.ok).toBe(false);
  expect(timed.elapsed).toBeGreaterThanOrEqual(2900);
  expect(timed.elapsed).toBeLessThan(4500);
  expect(timed.state).toMatchObject({ trackId: 'cors', status: 'playing' });
  results.push({ name: 'Three-second timeout preserves old native playback', timed });
  const corrupt = await play('损坏音频');
  expect(corrupt.ok).toBe(false);
  expect(corrupt.state).toMatchObject({ trackId: 'cors', status: 'playing' });
  results.push({ name: 'Corrupt audio fails without interrupting old track', corrupt });
  const delayed = await play('延迟 CORS 音频');
  expect(delayed.ok).toBe(false);
  expect(delayed.elapsed).toBeGreaterThanOrEqual(2900);
  expect(delayed.elapsed).toBeLessThan(4000);
  expect(delayed.state).toMatchObject({ trackId: 'cors', status: 'playing' });
  const delayedCalls = requests.filter(r => r.url === '/latecors');
  expect(delayedCalls.some(r => r.origin)).toBe(true);
  expect(delayedCalls.some(r => !r.origin)).toBe(true);
  results.push({ name: 'Delayed CORS failure and native retry share the same three-second deadline', delayed });
  const hangRequests = requests.filter(r => r.url === '/hang').length;
  await page.getByRole('button', { name: '超时音频', exact: true }).click();
  await expect.poll(() => requests.filter(r => r.url === '/hang').length).toBeGreaterThan(hangRequests);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.locator('#pause-result')).not.toBeEmpty();
  await expect(page.locator('pre').first()).toContainText('播放请求已取消');
  const cancelled = JSON.parse(await page.locator('pre').first().textContent());
  const paused = JSON.parse(await page.locator('#pause-result').textContent());
  expect(cancelled.ok).toBe(false);
  expect(cancelled.elapsed).toBeLessThan(2000);
  expect(paused.state).toMatchObject({ trackId: 'cors', status: 'paused' });
  results.push({ name: 'Pause immediately cancels an in-flight replacement and pauses the old track', cancelled, paused });
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ results }, null, 2));
  console.log(JSON.stringify(results));
} catch (e) {
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ results, requests, error: String(e) }, null, 2));
  console.error(e);
  process.exitCode = 1;
} finally {
  await context.close();
  server.closeAllConnections();
  server.close();
  uiServer.close();
}
