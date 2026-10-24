import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackState, ReadingState } from '@/core/shared/contracts';
const mock = vi.hoisted(() => ({
  handler: null as null | ((msg: unknown, sender: object, sendResponse: (value: unknown) => void) => unknown),
  session: {} as Record<string, unknown>,
  state: { status: 'playing', trackId: 'cc01', title: 'A', volume: 40, positionSec: 20 } as PlaybackState,
  pauses: 0,
  offscreenMissing: false,
  alarms: [] as Array<{ name: string; when?: number }>,
  onAlarm: null as null | ((alarm: { name: string }) => unknown),
  pendingPlay: null as null | (() => void),
  delayPlay: false,
}));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (fn: () => void) => fn }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: {
    getURL: (p: string) => p,
    onMessage: { addListener: (fn: typeof mock.handler) => { mock.handler = fn; } },
    onStartup: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() },
  },
  storage: { local: { get: async () => ({}), set: async () => {} }, session: {
    get: async () => mock.session,
    set: async (data: object) => { Object.assign(mock.session, data); },
  } },
  tabs: { query: async () => [{ id: 1 }], sendMessage: async (_id: number, message: { type?: string }) =>
    message.type === 'MBOOK_CONTENT_PROBE' ? { alive: true } : undefined,
    onRemoved: { addListener: vi.fn() }, onActivated: { addListener: vi.fn() } },
  scripting: { executeScript: async () => [] },
  alarms: { get: async () => ({}), create: async (name: string, info: { when?: number }) => { mock.alarms.push({ name, ...info }); },
    onAlarm: { addListener: (fn: typeof mock.onAlarm) => { mock.onAlarm = fn; } } },
} }));
vi.mock('@/core/playback/offscreen-client', () => ({
  getOffscreenPlaybackState: async () => mock.offscreenMissing ? null : ({ ...mock.state }),
  pauseInOffscreen: async () => {
    mock.pendingPlay?.();
    mock.pauses++; mock.state.status = 'paused'; return { ok: true, state: { ...mock.state } };
  },
  resumeInOffscreen: async () => {
    mock.state.status = 'playing'; return { ok: true, state: { ...mock.state } };
  },
  playInOffscreen: async (cmd: { trackId: string; title: string }) => {
    if (mock.delayPlay) {
      return await new Promise(resolve => {
        mock.pendingPlay = () => { mock.pendingPlay = null; resolve({ ok: false, state: { ...mock.state }, error: '播放请求已取消' }); };
      });
    }
    mock.offscreenMissing = false;
    mock.state = { ...mock.state, ...cmd, status: 'playing' };
    return { ok: true, state: { ...mock.state } };
  },
  setVolumeInOffscreen: async () => {}, preloadInOffscreen: async () => {},
  cancelAudioWorker: async () => {}, wakeAudioWorker: async () => {},
}));
vi.mock('@/core/sources', () => ({
  isSyncing: () => false, syncMusicLibrary: async () => {}, resolvePlayableUrl: async () => null,
  getSourceStatus: async () => ({ state: 'unknown' }), probeSong: async () => false,
}));

async function boot() {
  const module = await import('@/entrypoints/background');
  (module.default as unknown as () => void)();
  await send({ type: 'GET_STATUS' });
}
async function send(msg: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const held = mock.handler?.(msg, { tab: { id: 1, active: true } }, resolve);
    if (held !== true) reject(new Error('Background failed to keep the response port open'));
  });
}
function heartbeat(state: ReadingState['state']) {
  return send({ type: 'READING_HEARTBEAT', state: {
    state, window_id: 'window-a', page_active: state !== 'inactive', updated_at: Date.now(),
    extractor: 'generic', reading_speed_cpm: 300,
  } });
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
  vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist: async () => true } });
  mock.session = {}; mock.pauses = 0; mock.alarms = []; mock.offscreenMissing = false;
  mock.pendingPlay = null; mock.delayPlay = false;
  mock.state = { status: 'playing', trackId: 'cc01', title: 'A', volume: 40, positionSec: 20 };
  vi.resetModules();
  const { db } = await import('@/core/db/dexie');
  await db.settings.clear(); await db.userEvents.clear(); await db.sceneStats.clear(); await db.songs.clear();
  await db.readingAnalyses.clear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('background scheduler integration', () => {
  it('waits for the assigned model, uses exactly its eight scores, and keeps manual pause authoritative', async () => {
    await boot();
    const { db } = await import('@/core/db/dexie');
    await send({ type: 'UPDATE_SETTINGS', patch: { models: [
      { id: 'qwen', name: '', model: 'qwen3.8-omni-flash', endpoint: 'https://test.invalid/v1', api_key: 'test' },
    ], text_model_id: 'qwen' } });
    let finish!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const read = (windowId: string) => send({ type: 'READING_HEARTBEAT', state: {
      state: 'focused', window_id: windowId, page_active: true, updated_at: Date.now(),
      extractor: 'generic', reading_speed_cpm: 300, visible_text: '非常悲伤！',
    } });
    await read('model-only');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mock.state.trackId).toBe('cc01');
    expect(await db.readingAnalyses.count()).toBe(0); // no dictionary-first switch/record
    vi.setSystemTime(Date.now() + 6000);
    await read('model-only');
    expect(fetcher).toHaveBeenCalledTimes(1); // slower than update interval still one request
    await send({ type: 'PAUSE' });
    const vector = [.12, .23, .34, .45, .56, .67, .78, .89];
    finish({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ emotion: vector, confidence: .8 }) } }] }) });
    await vi.waitFor(async () => expect(await db.readingAnalyses.count()).toBe(1));
    expect(await send({ type: 'GET_STATUS' })).toMatchObject({
      mood: { vector }, text_analysis: { source: 'model', status: 'complete' },
    });
    expect((await db.readingAnalyses.toArray())[0]).toMatchObject({ profile: null, matchingVector: vector, analysisSource: 'model' });
    expect(mock.state.status).toBe('paused');
  });
  it('rejects stale-window responses and reports model failures without running dictionary fallback', async () => {
    await boot();
    const { db } = await import('@/core/db/dexie');
    await send({ type: 'UPDATE_SETTINGS', patch: { models: [
      { id: 'qwen', name: '', model: 'qwen3.8-omni-flash', endpoint: 'https://test.invalid/v1', api_key: 'test' },
    ], text_model_id: 'qwen' } });
    let finish!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const read = (windowId: string) => send({ type: 'READING_HEARTBEAT', state: {
      state: 'focused', window_id: windowId, page_active: true, updated_at: Date.now(),
      extractor: 'generic', reading_speed_cpm: 300, visible_text: '非常悲伤！',
    } });
    await read('old-window');
    await read('new-window'); // same 6s interval: no new API yet, but old result is obsolete
    finish({ ok: true, json: async () => ({ choices: [{ message: { content: '{"emotion":[1,0,0,0,0,0,0,0]}' } }] }) });
    await new Promise(resolve => setTimeout(resolve, 20));
    await send({ type: 'GET_STATUS' });
    expect(await db.readingAnalyses.count()).toBe(0);
    vi.setSystemTime(Date.now() + 6000);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    await read('new-window');
    await vi.waitFor(async () => expect(await db.readingAnalyses.count()).toBe(1));
    expect((await db.readingAnalyses.toArray())[0]).toMatchObject({
      profile: null, matchingVector: null, analysisSource: 'model', error: 'LLM HTTP 401',
    });
    expect(mock.state.trackId).toBe('cc01');
    expect(await send({ type: 'GET_STATUS' })).toMatchObject({ text_analysis: { status: 'failed' } });
  });
  it('switches on the first analyzed window before 45s even when similarity gain is below 15', async () => {
    await boot();
    mock.state.positionSec = 1;
    const { settingsRepo } = await import('@/core/db/settings.repo');
    const { db } = await import('@/core/db/dexie');
    // 已安装版本的旧门槛不得继续生效。
    await db.settings.put({ key: 'app', value: {
      ...(await settingsRepo.get()), stable_windows_k: 4, delta_e_threshold: .5,
      min_switch_interval_sec: 120, switch_threshold: 60,
    } as never });
    const read = (text: string, windowId: string) => send({ type: 'READING_HEARTBEAT', state: {
      state: 'focused', window_id: windowId, page_active: true, updated_at: Date.now(),
      extractor: 'generic', reading_speed_cpm: 300, visible_text: text,
    } });
    await read('温柔', 'first');
    expect(mock.state.trackId).toBe('cc02');
    const { emotionScore } = await import('@/core/matching/scores');
    const { CC0_TRACKS } = await import('@/assets/cc0/manifest');
    const vector = [0, 0, .5, 0, 0, 0, 0, 0];
    const gain = emotionScore(vector, CC0_TRACKS.find(t => t.id === 'cc02')!.emotion) -
      emotionScore(vector, CC0_TRACKS.find(t => t.id === 'cc01')!.emotion);
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThan(15);
    const count = await db.userEvents.filter(e => e.action === 'play_start').count();
    await read('温柔', 'first');
    expect(await db.userEvents.filter(e => e.action === 'play_start').count()).toBe(count);
    vi.setSystemTime(Date.now() + 6000);
    mock.state.positionSec = 1;
    await read('悲伤', 'second');
    expect(mock.state.trackId).toBe('cc03'); // 距切歌6秒、无需连续变化或趋势置信度
    await send({ type: 'PAUSE' });
    vi.setSystemTime(Date.now() + 6000);
    await read('希望', 'third');
    expect(mock.state).toMatchObject({ trackId: 'cc03', status: 'paused' });
    expect(await settingsRepo.get()).not.toHaveProperty('switch_threshold');
  });
  it('handles pause while a serialized track switch awaits audio and never starts a fallback afterward', async () => {
    await boot();
    mock.delayPlay = true;
    const switching = send({ type: 'NEXT_TRACK' });
    await vi.waitFor(() => expect(mock.pendingPlay).not.toBeNull());
    const paused = await send({ type: 'PAUSE' });
    expect(paused).toMatchObject({ playback: { status: 'paused' } });
    await switching;
    await send({ type: 'GET_STATUS' });
    expect(mock.pendingPlay).toBeNull();
    expect(mock.state.status).toBe('paused');
    expect((mock.session.scheduler as { manualStop: boolean }).manualStop).toBe(true);
    await heartbeat('focused');
    expect(mock.state.status).toBe('paused');
  });
  it('keeps Chrome message ports open and returns a concrete initial status through sendResponse', async () => {
    await boot();
    expect(await send({ type: 'GET_STATUS' })).toMatchObject({
      ok: true, playback: { status: 'playing', trackId: 'cc01' }, source_status: { state: 'unknown' },
    });
  });
  it('recreates a reclaimed audio document at its saved position without counting a new play', async () => {
    await boot();
    await send({ type: 'NEXT_TRACK' });
    await send({ type: 'PAUSE' });
    const id = mock.state.trackId;
    const { db } = await import('@/core/db/dexie');
    const count = await db.userEvents.filter(e => e.action === 'play_start').count();
    mock.offscreenMissing = true;
    vi.resetModules();
    await boot();
    await heartbeat('focused');
    expect(mock.offscreenMissing).toBe(true); // manual pause wins even when audio document has gone
    await send({ type: 'RESUME' });
    expect(mock.state).toMatchObject({ status: 'playing', trackId: id, positionSec: 20 });
    expect(mock.offscreenMissing).toBe(false);
    expect(await db.userEvents.filter(e => e.action === 'play_start').count()).toBe(count);
  });
  it('sets a persisted one-shot 30-second inactive deadline', async () => {
    await boot();
    await heartbeat('inactive');
    expect(mock.alarms.find(a => a.name === 'mbook-idle-deadline')?.when).toBe(Date.now() + 30_000);
    vi.setSystemTime(Date.now() + 30_000);
    mock.onAlarm?.({ name: 'mbook-idle-deadline' });
    await send({ type: 'GET_STATUS' }); // drains serialized alarm work
    expect(mock.state.status).toBe('paused');
  });
  it('continues after natural end while browsing rather than leaving an active page silent', async () => {
    await boot();
    await send({ type: 'NEXT_TRACK' });
    const endedId = mock.state.trackId;
    await heartbeat('scanning');
    mock.state.status = 'stopped';
    await send({ type: 'OFFSCREEN_ENDED', trackId: endedId });
    expect(mock.state.status).toBe('playing');
  });
  it('keeps scanning audible and pauses only after 30 seconds inactive', async () => {
    await boot();
    await heartbeat('focused');
    vi.setSystemTime(Date.now() + 31_000);
    await heartbeat('scanning');
    expect(mock.pauses).toBe(0);
    await heartbeat('inactive');
    vi.setSystemTime(Date.now() + 31_000);
    await heartbeat('inactive');
    expect(mock.pauses).toBe(1);
    expect(mock.state.status).toBe('paused');
    await heartbeat('focused');
    expect(mock.state.status).toBe('playing');
  });
  it('preserves manual pause across a worker restart', async () => {
    await boot();
    await send({ type: 'PAUSE' });
    vi.resetModules();
    await boot();
    await heartbeat('focused');
    expect(mock.state.status).toBe('paused');
    expect((mock.session.scheduler as { manualStop: boolean }).manualStop).toBe(true);
  });
  it('saving model or playback settings does not clear an existing manual pause', async () => {
    await boot();
    await send({ type: 'PAUSE' });
    await send({ type: 'UPDATE_SETTINGS', patch: { plugin_enabled: true, base_volume: 50,
      models: [], text_model_id: null, music_model_id: null } });
    await heartbeat('focused');
    expect(mock.state.status).toBe('paused');
    expect((mock.session.scheduler as { manualStop: boolean }).manualStop).toBe(true);
  });
  it('switches a disliked track immediately without waiting for emotion or duration gates', async () => {
    await boot();
    await send({ type: 'DISLIKE_TRACK', trackId: 'cc01' });
    expect(mock.state.status).toBe('playing');
    expect(mock.state.trackId).not.toBe('cc01');
  });
});
