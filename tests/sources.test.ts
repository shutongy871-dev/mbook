import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ value: {} as Record<string, unknown>, set: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { storage: { local: {
  get: async () => storage.value,
  set: storage.set,
} } } }));
vi.mock('@/core/sources/netease', () => ({
  neteaseAdapter: { fetchLibrary: vi.fn(), search: vi.fn(), resolveUrl: vi.fn() },
  inspectLyrics: vi.fn(),
}));
import { db } from '@/core/db/dexie';
import { songsRepo } from '@/core/db/songs.repo';
import { neteaseAdapter } from '@/core/sources/netease';
import { getSourceStatus, isSyncing, resolveBackupUrls, syncMusicLibrary } from '@/core/sources';
import type { SourceTrack } from '@/core/sources/types';

const track: SourceTrack = {
  source: 'netease', sourceSongId: '1', title: 'Peace', artist: 'Someone', album: '',
  durationSec: 120, hasLyrics: false, popularityRaw: 10, bitrateKbps: 192,
  language: 'instrumental', streamUrl: 'https://test.invalid/audio', urlExpireAt: Date.now() + 3600000,
  playable: true, copyrightAvailable: true,
};
beforeEach(async () => {
  await db.songs.clear();
  storage.value = {};
  storage.set.mockImplementation(async (value: Record<string, unknown>) => { Object.assign(storage.value, value); });
  vi.mocked(neteaseAdapter.fetchLibrary).mockResolvedValue({ state: 'connected', name: 'Reader', tracks: [track] });
});
afterEach(() => vi.restoreAllMocks());

describe('source synchronization and acceptance counts', () => {
  it('counts committed primary-source songs separately from eligible URL probes', async () => {
    const make = (id: string) => songsRepo.makeSong({ ...track, sourceSongId: id, title: id });
    await db.songs.bulkPut([
      make('1'), { ...make('2'), playable: false },
      { ...make('3'), blacklisted: true }, { ...make('4'), copyright_available: false },
      { ...make('5'), primary_source: 'qq' },
      { ...make('6'), song_id: 'qq:merged', primary_source: 'netease' },
    ]);
    storage.value.sourceStatus = { state: 'connected', name: 'Reader' };
    expect(await getSourceStatus()).toMatchObject({
      state: 'connected', name: 'Reader', library_count: 5, playable_count: 2,
    });
  });
  it('publishes connected only after songs commit, forwarding measured metadata', async () => {
    storage.set.mockImplementation(async (value: Record<string, unknown>) => {
      if ((value.sourceStatus as { state: string }).state === 'connected') {
        expect(await db.songs.get('netease:1')).toMatchObject({
          bitrate_kbps: 192, language: 'instrumental', copyright_available: true,
        });
      }
      Object.assign(storage.value, value);
    });
    expect(await syncMusicLibrary()).toEqual({ added: 1, total: 1 });
    expect((await getSourceStatus())?.state).toBe('connected');
    expect(isSyncing()).toBe(false);
  });
  it('reports database failure without announcing connected or losing the existing library', async () => {
    await db.songs.put(songsRepo.makeSong({ ...track, sourceSongId: 'existing' }));
    vi.spyOn(songsRepo, 'upsertMany').mockRejectedValueOnce(new Error('database failed'));
    expect(await syncMusicLibrary()).toEqual({ added: 0, total: 1 });
    expect(storage.set.mock.calls.every(([value]) => value.sourceStatus.state !== 'connected')).toBe(true);
    expect((await getSourceStatus())?.state).toBe('error');
    expect(isSyncing()).toBe(false);
  });
  it('reports signed-out on an empty response while retaining old songs', async () => {
    await db.songs.put(songsRepo.makeSong(track));
    vi.mocked(neteaseAdapter.fetchLibrary).mockResolvedValueOnce({ state: 'signed_out', tracks: [] });
    expect(await syncMusicLibrary()).toEqual({ added: 0, total: 1 });
    expect(await getSourceStatus()).toMatchObject({ state: 'signed_out', library_count: 1 });
  });
  it('propagates cancellation of the final backup request without committing a late URL', async () => {
    const song = { ...songsRepo.makeSong(track), backup_sources: [
      { source: 'netease', sourceSongId: '2', url: '', expireAt: 0 },
    ] };
    await db.songs.put(song);
    const controller = new AbortController();
    vi.mocked(neteaseAdapter.resolveUrl).mockImplementationOnce(async () => {
      controller.abort();
      return { ...track, streamUrl: 'https://test.invalid/late' };
    });
    await expect(resolveBackupUrls(song.song_id, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect((await db.songs.get(song.song_id))?.backup_sources).toEqual(song.backup_sources);
  });
  it('returns the first ready backup without waiting on an expired secondary backup', async () => {
    const song = { ...songsRepo.makeSong(track), backup_sources: [
      { source: 'netease', sourceSongId: '2', url: 'https://test.invalid/ready', expireAt: Date.now() + 3600000 },
      { source: 'netease', sourceSongId: '3', url: '', expireAt: 0 },
    ] };
    await db.songs.put(song);
    const resolve = vi.mocked(neteaseAdapter.resolveUrl);
    resolve.mockClear();
    expect(await resolveBackupUrls(song.song_id, undefined, 1)).toEqual(['https://test.invalid/ready']);
    expect(resolve).not.toHaveBeenCalled();
  });
});
