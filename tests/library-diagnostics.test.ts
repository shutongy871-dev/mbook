import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({
  browser: { runtime: { getURL: (path: string) => `chrome-extension://test${path}` } },
}));
import { db } from '@/core/db/dexie';
import { songsRepo } from '@/core/db/songs.repo';
import { DEFAULT_SETTINGS, settingsRepo } from '@/core/db/settings.repo';
import { libraryDiagnosticsRepo } from '@/core/db/library-diagnostics.repo';
import { diagnoseLibrary } from '@/core/matching/library-diagnostics';
import { assemblePool, songToCandidate } from '@/core/matching/candidate-pool';
import { filterReason, filterReasons } from '@/core/matching/hard-filter';
import type { Song, SongProfile } from '@/core/shared/contracts';

const makeSong = (id: string, patch: Partial<Song> = {}): Song => ({
  ...songsRepo.makeSong({ source: 'netease', sourceSongId: id, title: id,
    artist: 'artist', durationSec: 120, hasLyrics: false, bitrateKbps: 192,
    playable: true, streamUrl: 'https://audio.invalid/track', urlExpireAt: Date.now() + 3600_000 }),
  profile_status: 'audio_done', ...patch,
});
const makeProfile = (id: string, patch: Partial<SongProfile> = {}): SongProfile => ({
  song_id: `netease:${id}`, emotion_vector: [.5, 0, 0, 0, 0, 0, 0, 0],
  music_tags: [], semantic_text: '', semantic_embedding: [], audio_features: null,
  popularity_raw: 0, popularity_score: 50, platform_tags: [], ...patch,
});
beforeEach(async () => {
  await db.songs.clear();
  await db.songProfiles.clear();
  await db.settings.clear();
});

describe('whole-library diagnostics', () => {
  it('separates pending from missing, null, old and zero profiles, and accepts failed fallback', () => {
    const ids = ['pending', 'missing', 'null', 'old', 'zero', 'failed'];
    const songs = ids.map(id => makeSong(id, id === 'pending' ? { profile_status: 'pending' } :
      id === 'failed' ? { profile_status: 'failed' } : {}));
    const result = diagnoseLibrary(songs, [
      makeProfile('pending'), makeProfile('null', { emotion_vector: null }),
      makeProfile('old', { emotion_vector: [.5, 0, 0] }),
      makeProfile('zero', { emotion_vector: Array(8).fill(0) }), makeProfile('failed'),
    ], DEFAULT_SETTINGS);
    expect(result.counts).toMatchObject({ pending: 1, invalid_profile: 4, eligible: 1 });
    expect(result.blocked).toBe(5);
    expect(result.rows.find(row => row.id.endsWith('pending'))?.categories).not.toContain('invalid_profile');
    expect(result.rows.find(row => row.id.endsWith('failed'))?.eligible).toBe(true);
  });

  it('counts overlapping reasons once per category while preserving the first real hard filter', () => {
    const song = makeSong('overlap', { playable: false, copyright_available: false,
      has_lyrics: true, bitrate_kbps: 0, duration_sec: 30 });
    const profile = makeProfile('overlap', { emotion_vector: null, music_tags: [{ tag: '摇滚', confidence: 1 }] });
    const settings = { ...DEFAULT_SETTINGS, lyric_policy: 'instrumental_only' as const, style_blacklist: ['摇滚'] };
    const result = diagnoseLibrary([song], [profile], settings);
    expect(result.counts).toMatchObject({ unplayable: 1, vocals: 1, other: 1, invalid_profile: 1 });
    expect(result.blocked).toBe(1);
    expect(result.rows[0]!.reasons.map(reason => reason.code)).toEqual([
      'invalid_profile', 'unplayable', 'copyright', 'duration', 'quality', 'lyrics', 'vocal_density', 'style',
    ]);
    const candidate = songToCandidate(song, profile);
    expect(filterReason(candidate, settings)).toBe('unplayable');
    expect(filterReasons(candidate, settings)).toHaveLength(7);
    expect(result.rows[0]!.reasons.find(reason => reason.code === 'unplayable')?.message).toContain('尚无地址探测');
    expect(result.rows[0]!.reasons.find(reason => reason.code === 'vocal_density')?.message).toContain('未实测');
  });

  it('uses measured density when present and keeps the existing any-policy .8 threshold', () => {
    const song = makeSong('voice', { has_lyrics: false });
    const profile = makeProfile('voice', { audio_features: {
      bpm: 80, vocal_density: .9, dynamic_range: 0, energy_curve: [],
    } });
    expect(diagnoseLibrary([song], [profile], { ...DEFAULT_SETTINGS, lyric_policy: 'any' }).counts.vocals).toBe(1);
    profile.audio_features!.vocal_density = .4;
    expect(diagnoseLibrary([song], [profile], DEFAULT_SETTINGS).counts.vocals).toBe(0);
  });

  it('includes blacklisted songs, respects saved switches and does not treat expiry as unplayable', () => {
    const songs = [makeSong('blacklist', { blacklisted: true }), makeSong('expired', { url_expire_at: 0 })];
    const profiles = songs.map(song => makeProfile(song.source_song_id!));
    const result = diagnoseLibrary(songs, profiles, DEFAULT_SETTINGS);
    expect(result.total).toBe(2);
    expect(result.counts).toMatchObject({ other: 1, eligible: 1, unplayable: 0 });
    expect(result.rows.find(row => row.eligible)?.notes.join(' ')).toContain('重新解析');
    expect(diagnoseLibrary(songs, profiles, { ...DEFAULT_SETTINGS, netease_enabled: false }).counts.eligible).toBe(0);
  });

  it('reads all database rows and agrees with production pool + hard filters without exporting keys or URLs', async () => {
    const songs = [makeSong('ok'), makeSong('pending', { profile_status: 'pending' }),
      makeSong('null'), makeSong('voice', { has_lyrics: true }), makeSong('blocked', { blacklisted: true })];
    await db.songs.bulkPut(songs);
    await db.songProfiles.bulkPut([makeProfile('ok'), makeProfile('voice'), makeProfile('blocked'),
      makeProfile('null', { emotion_vector: null })]);
    await settingsRepo.update({ llm_key: 'secret-test' });
    const result = await libraryDiagnosticsRepo.snapshot();
    const actual = (await assemblePool(new Set())).filter(candidate =>
      candidate.source === 'netease' && !filterReason(candidate, DEFAULT_SETTINGS)).map(candidate => candidate.id);
    expect(result.rows.filter(row => row.eligible).map(row => row.id)).toEqual(actual);
    expect(result.total).toBe(5);
    expect(JSON.stringify(result)).not.toContain('secret-test');
    expect(JSON.stringify(result)).not.toContain('https://audio.invalid');
  });
});
