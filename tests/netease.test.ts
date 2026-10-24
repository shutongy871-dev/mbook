import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: { cookies: { get: async () => ({ value: 'test-csrf' }) } } }));
vi.mock('@/core/sources/netease-crypto', () => ({
  weapi: async (payload: object) => ({ params: JSON.stringify(payload), encSecKey: 'test' }),
}));
import { neteaseAdapter } from '@/core/sources/netease';
afterEach(() => vi.unstubAllGlobals());

describe('personal Netease library adapter', () => {
  it('reads account playlists and fills missing tracks rather than substituting a search library', async () => {
    const paths: string[] = [];
    const responses = [
      { code: 200, profile: { userId: 9, nickname: 'Reader' } },
      { code: 200, more: false, playlist: [{ id: 10, tags: ['治愈'] }] },
      { code: 200, playlist: { tracks: [{ id: 1, name: 'A', ar: [{ name: 'Main' }, { name: 'Guest' }], dt: 120000 }],
        trackIds: [{ id: 1 }, { id: 2 }] } },
      { songs: [{ id: 2, name: 'B', ar: [{ name: 'Main' }], dt: 180000 }] },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      paths.push(new URL(url).pathname);
      const payload = JSON.parse(new URLSearchParams(options.body as string).get('params')!);
      expect(payload.csrf_token).toBe('test-csrf');
      return { ok: true, json: async () => responses.shift() };
    }));
    const result = await neteaseAdapter.fetchLibrary();
    expect(result.state).toBe('connected');
    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0]).toMatchObject({ artist: 'Main', channels: ['netease_playlist'], hasLyrics: true });
    expect(paths).toEqual(['/weapi/w/nuser/account/get', '/weapi/user/playlist', '/weapi/v6/playlist/detail', '/weapi/v3/song/detail']);
  });
  it('distinguishes signed-out from API failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: 200 }) })));
    expect((await neteaseAdapter.fetchLibrary()).state).toBe('signed_out');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: 50000005 }) })));
    await expect(neteaseAdapter.fetchLibrary()).rejects.toThrow('账号状态查询失败');
  });
  it('deduplicates songs across personal playlists while preserving their atmosphere tags', async () => {
    const song = { id: 1, name: 'A', ar: [{ name: 'Main' }], dt: 120000 };
    const responses = [
      { code: 200, profile: { userId: 9 } },
      { code: 200, more: false, playlist: [{ id: 10 }, { id: 11 }] },
      { code: 200, playlist: { tracks: [song], tags: ['治愈'] } },
      { code: 200, playlist: { tracks: [song], tags: ['专注'] } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => responses.shift() })));
    const result = await neteaseAdapter.fetchLibrary();
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.playlistTags).toEqual(['治愈', '专注']);
  });
  it('rejects a failed missing-track response instead of announcing a complete library', async () => {
    const responses = [
      { code: 200, profile: { userId: 9 } },
      { code: 200, more: false, playlist: [{ id: 10 }] },
      { code: 200, playlist: { tracks: [], trackIds: [{ id: 1 }] } },
      { code: 50000005 },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => responses.shift() })));
    await expect(neteaseAdapter.fetchLibrary()).rejects.toThrow('歌单曲目补齐失败');
  });
  it('leaves a missing stream bitrate unknown instead of inventing a high-quality value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
      data: [{ code: 200, url: 'https://example.com/full.mp3', expi: 1800 }],
    }) })));
    expect(await neteaseAdapter.resolveUrl({
      source: 'netease', sourceSongId: '1', title: 'A', artist: 'B', album: '', durationSec: 120,
      hasLyrics: true, bitrateKbps: 0, popularityRaw: 0, streamUrl: '', urlExpireAt: 0, playable: false,
    })).toMatchObject({ bitrateKbps: 0, playable: true });
  });
  it('rejects a trial-only URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
      data: [{ code: 200, url: 'https://example.com/trial.mp3', freeTrialInfo: { start: 0, end: 30 } }],
    }) })));
    expect(await neteaseAdapter.resolveUrl({
      source: 'netease', sourceSongId: '1', title: 'A', artist: 'B', album: '', durationSec: 120,
      hasLyrics: true, bitrateKbps: 0, popularityRaw: 0, streamUrl: '', urlExpireAt: 0, playable: false,
    })).toBeNull();
  });
});
