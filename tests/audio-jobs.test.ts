import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: { runtime: {
  getURL: (url: string) => url, sendMessage: vi.fn(async () => ({ ok: true })),
} } }));
import { db } from '@/core/db/dexie';
import { settingsRepo } from '@/core/db/settings.repo';
import { songsRepo } from '@/core/db/songs.repo';
import { profilesRepo } from '@/core/db/profiles.repo';
import { audioBudget, claimAudioJob, enqueueAudioJobs, failAudioJob } from '@/core/db/audio-jobs.repo';
import { commitAudioProfile } from '@/core/understanding/audio-tag-worker';
import { tagSong, fuseSongProfile } from '@/core/understanding/song-tagger';
import { AUDIO_PROFILE_VERSION, audioIdentity } from '@/core/llm/qwen-audio';
import { diagnoseLibrary } from '@/core/matching/library-diagnostics';
import { songToCandidate } from '@/core/matching/candidate-pool';
import type { AudioEmotionProfile, Settings } from '@/core/shared/contracts';
let settings: Settings;
const make = (id: string) => songsRepo.makeSong({ source: 'netease', sourceSongId: id, title: `歌 ${id}`,
  artist: 'Artist', durationSec: 120, hasLyrics: false, bitrateKbps: 192, playable: true });
const vector = [.2, .1, .7, .3, 0, 0, .2, 0];
function result(known = true): AudioEmotionProfile {
  return { version: AUDIO_PROFILE_VERSION, identity: audioIdentity(settings),
    model: 'qwen3.8-omni-flash', analyzed_at: Date.now(), sampled_sec: 60,
    coverage: known ? 1 : 0, emotion: known ? vector : null,
    segments: [0, 1, 2].map(index => ({ index, start_sec: index * 50, input_start_sec: index * 20,
      duration_sec: 20, emotion: known ? vector : null, confidence: known ? .8 : 0, evidence: known ? '舒缓钢琴' : '无法判断' })),
  };
}
beforeEach(async () => {
  await db.songs.clear(); await db.songProfiles.clear(); await db.audioJobs.clear(); await db.settings.clear();
  settings = await settingsRepo.update({ song_audio_enabled: true, song_audio_endpoint: 'https://example.test/v1',
    song_audio_key: 'test-only-secret', song_audio_limit: 2 });
  await songsRepo.upsertMany([make('1'), make('2'), make('3')]);
});
describe('persistent audio jobs and profile precedence', () => {
  it('claims atomically, caps cumulative attempts, and never automatically retries expired work', async () => {
    expect(await enqueueAudioJobs()).toMatchObject({ queued: 2 });
    const jobs = await Promise.all([claimAudioJob(settings), claimAudioJob(settings)]);
    expect(jobs.filter(Boolean)).toHaveLength(1);
    const first = jobs.find(j => j)!;
    expect(await audioBudget()).toEqual({ attempts: 1 });
    const second = await claimAudioJob(settings, Date.now() + 6 * 60_000);
    expect(second?.song_id).not.toBe(first.song_id);
    expect(await db.audioJobs.get(first.song_id)).toMatchObject({ status: 'failed' });
    await failAudioJob(second!, '测试失败');
    expect(await claimAudioJob(settings)).toBeNull();
    await expect(enqueueAudioJobs()).rejects.toThrow('累计尝试上限');
    settings = await settingsRepo.update({ song_audio_limit: 3 });
    expect(await enqueueAudioJobs()).toMatchObject({ queued: 1 }); // only untouched third song
    expect(await audioBudget()).toEqual({ attempts: 2 });
  });
  it('persists audio vectors into the candidate path, reuses cache, protects against late metadata writes', async () => {
    await enqueueAudioJobs('netease:1');
    const job = (await claimAudioJob(settings))!;
    const song = (await songsRepo.get(job.song_id))!;
    await tagSong(song, { ...settings, llm_key: '' });
    const stale = (await profilesRepo.get(song.song_id))!;
    await commitAudioProfile(job, result());
    expect(await enqueueAudioJobs(song.song_id)).toMatchObject({ queued: 0, cached: true });
    await profilesRepo.upsert({ ...stale, emotion_vector: Array(8).fill(.9) });
    await tagSong(song, settings);
    const profile = (await profilesRepo.get(song.song_id))!;
    expect(profile.emotion_vector).toEqual(vector);
    expect(fuseSongProfile(song, profile, true).emotion_vector).toEqual(vector);
    expect(songToCandidate((await songsRepo.get(song.song_id))!, profile, Date.now()).emotion).toEqual(vector);
    const diagnostics = diagnoseLibrary([song], [profile], settings, Date.now(), await db.audioJobs.toArray());
    expect(diagnostics.rows[0]?.profileSource).toBe('audio_model');
    expect(JSON.stringify(diagnostics)).not.toContain(settings.song_audio_key);
    expect(JSON.stringify(diagnostics)).not.toContain('data:audio');
  });
  it('preserves a previous valid profile on unknown and failure, records evidence separately', async () => {
    await enqueueAudioJobs('netease:1');
    const job = (await claimAudioJob(settings))!;
    await tagSong((await songsRepo.get(job.song_id))!, { ...settings, llm_key: '' });
    const before = (await profilesRepo.get(job.song_id))!;
    before.emotion_vector = vector;
    await profilesRepo.upsert(before);
    await commitAudioProfile(job, result(false));
    expect((await profilesRepo.get(job.song_id))?.emotion_vector).toEqual(vector);
    expect(await db.audioJobs.get(job.song_id)).toMatchObject({ status: 'unknown', result: { emotion: null, coverage: 0 } });
    // A late response with a different request id cannot overwrite the newer job.
    await db.audioJobs.update(job.song_id, { status: 'processing', request_id: 'new' });
    await commitAudioProfile(job, result());
    expect((await profilesRepo.get(job.song_id))?.audio_emotion).toBeUndefined();
  });
  it('halts the batch on key/permission/limit errors until an explicit start', async () => {
    await enqueueAudioJobs();
    const job = (await claimAudioJob(settings))!;
    await failAudioJob(job, 'HTTP 401', true);
    expect(await claimAudioJob(settings)).toBeNull();
    expect(await audioBudget()).toMatchObject({ halted: 'HTTP 401', attempts: 1 });
    settings = await settingsRepo.update({ song_audio_limit: 3 });
    await enqueueAudioJobs();
    expect((await claimAudioJob(settings))?.status).toBe('processing');
  });
});
