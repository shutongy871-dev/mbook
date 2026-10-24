import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/core/llm/client', () => ({
  isLlmConfigured: (s: { llm_key: string }) => Boolean(s.llm_key),
  chatJson: vi.fn(async () => ({
    emotion: [.1, 0, .3, .1, 0, 0, 0, 0], tags: ['平静舒缓'],
    semantic_text: '安静钢琴', confidence: .9,
  })),
}));
import { db } from '@/core/db/dexie';
import { songsRepo, dedupKey } from '@/core/db/songs.repo';
import { tagSong, TAG_VERSION } from '@/core/understanding/song-tagger';
import { DEFAULT_SETTINGS } from '@/core/db/settings.repo';
import { chatJson } from '@/core/llm/client';
import { summarizeAudio, spectralCentroid } from '@/core/playback/audio-analysis';
import { TagSchema, voteTags } from '@/core/understanding/taxonomy';
const make = (id = '1', source = 'netease') => songsRepo.makeSong({
  source, sourceSongId: id, title: 'Peace', artist: 'Someone', durationSec: 120, hasLyrics: false,
});
beforeEach(async () => {
  await db.songs.clear(); await db.songProfiles.clear(); await db.userEvents.clear(); await db.sceneStats.clear();
  vi.mocked(chatJson).mockClear();
});
describe('library identity and profile lifecycle', () => {
  it('normalizes typography and includes duration while preserving song versions', () => {
    expect(dedupKey('Ｐｅａｃｅ ', 'Someone!', 121)).toBe(dedupKey('peace', 'someone', 120));
    expect(dedupKey('peace', 'someone', 130)).not.toBe(dedupKey('peace', 'someone', 120));
  });
  it('merges sources without losing feedback, original identity or alternate addresses', async () => {
    const song = { ...make('qq', 'qq'), blacklisted: true, last_matched_at: 42, stream_url: 'https://qq/audio' };
    await songsRepo.upsertMany([song]);
    await songsRepo.upsertMany([{ ...make('ne'), stream_url: 'https://netease/audio' }]);
    const all = await db.songs.toArray();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ song_id: song.song_id, primary_source: 'netease', source_song_id: 'ne',
      blacklisted: true, last_matched_at: 42, stream_url: 'https://netease/audio' });
    expect(all[0]!.backup_sources).toContainEqual(expect.objectContaining({ source: 'qq', url: 'https://qq/audio' }));
  });
  it('persists no-Key tagging version and upgrades exactly once after Key configuration', async () => {
    const song = make();
    await songsRepo.upsertMany([song]);
    await tagSong(song, DEFAULT_SETTINGS);
    expect(await songsRepo.get(song.song_id)).toMatchObject({ tag_version: TAG_VERSION, profile_status: 'audio_done' });
    await db.songs.update(song.song_id, { last_tag_attempt: Date.now() - 3600_001 });
    expect(await songsRepo.listPendingTag(20, false, TAG_VERSION)).toHaveLength(0);
    expect(await songsRepo.listPendingTag(20, true, TAG_VERSION)).toHaveLength(1);
    const settings = { ...DEFAULT_SETTINGS, llm_key: 'test-key' };
    await tagSong((await songsRepo.get(song.song_id))!, settings);
    await tagSong((await songsRepo.get(song.song_id))!, settings);
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(await songsRepo.get(song.song_id)).toMatchObject({ tag_version: TAG_VERSION, profile_status: 'llm_done' });
    await songsRepo.upsertMany([song]);
    expect((await songsRepo.get(song.song_id))?.tag_version).toBe(TAG_VERSION);
  });
  it('refreshes primary metadata under a stable merged id without losing probes or feedback', async () => {
    await songsRepo.upsertMany([{ ...make('qq', 'qq'), blacklisted: true }]);
    await songsRepo.upsertMany([{ ...make('ne'), popularity_raw: 10, stream_url: 'https://audio', playable: true, bitrate_kbps: 192 }]);
    await db.songs.update('qq:qq', { last_probe_at: Date.now(), has_lyrics: false, language: 'instrumental' });
    await songsRepo.upsertMany([{ ...make('ne'), popularity_raw: 90, has_lyrics: true }]);
    expect(await db.songs.get('qq:qq')).toMatchObject({
      primary_source: 'netease', source_song_id: 'ne', popularity_raw: 90,
      stream_url: 'https://audio', playable: true, bitrate_kbps: 192, has_lyrics: false,
      language: 'instrumental', blacklisted: true,
    });
    expect((await db.songs.get('qq:qq'))?.backup_sources.filter(b => b.source === 'netease')).toHaveLength(0);
  });
  it('cleans expired songs and profiles together, retaining blacklist and recent songs', async () => {
    const now = Date.now();
    const expired = { ...make(), first_seen_at: now - 31 * 86400_000 };
    await songsRepo.upsertMany([expired, { ...make('2'), title: 'Keep', blacklisted: true, first_seen_at: expired.first_seen_at }]);
    await tagSong(expired, DEFAULT_SETTINGS);
    expect(await songsRepo.prune(now)).toBe(1);
    expect(await db.songProfiles.get(expired.song_id)).toBeUndefined();
    expect(await db.songs.count()).toBe(1);
  });
  it('rejects invented tags and renormalizes votes for missing sources', () => {
    expect(TagSchema.safeParse('随便的标签').success).toBe(false);
    expect(voteTags([{ weight: .45, tags: [] }, { weight: .25, tags: [{ tag: '平静舒缓', confidence: .8 }] }]))
      .toEqual([{ tag: '平静舒缓', confidence: .8 }]);
  });
  it('detects tempo in a 120 BPM envelope and leaves unmeasured vocals unknown', () => {
    const envelope = Array.from({ length: 600 }, (_, i) => i % 10 === 0 ? .5 : .02);
    const result = summarizeAudio(envelope);
    expect(result?.bpm).toBe(120);
    expect(result?.energy_curve).toHaveLength(6);
    expect(result?.vocal_density).toBeNull();
    expect(summarizeAudio(Array(600).fill(0))).toBeNull();
    const spectrum = new Float32Array(1024).fill(-Infinity);
    spectrum[64] = 0;
    expect(spectralCentroid(spectrum, 32000, 2048)).toBe(1000);
    expect(spectralCentroid(new Float32Array(1024).fill(-Infinity), 32000, 2048)).toBeUndefined();
  });
});
