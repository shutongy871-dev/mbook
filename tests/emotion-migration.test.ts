import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { db } from '@/core/db/dexie';

describe('v3 to eight-dimensional storage upgrade', () => {
  it('invalidates old images and models while retaining measured audio and raw evidence', async () => {
    db.close();
    await Dexie.delete('mbook');
    const previous = new Dexie('mbook');
    previous.version(3).stores({
      songs: 'song_id, dedup_key, last_matched_at, tag_version, blacklisted',
      songProfiles: 'song_id', userEvents: '++id, ts, song_id, scene_bucket',
      sceneStats: '[scene_bucket+song_id], scene_bucket, song_id, updated_at',
      settings: 'key', ltrModel: 'id', readingAnalyses: '++id, ts, windowId',
    });
    await previous.table('songs').put({ song_id: 's', tag_version: 'v2', profile_status: 'llm_done', last_tag_attempt: 1 });
    // 三维旧数据作为升级fixture，不能按数值转换成新画像。
    await previous.table('songProfiles').put({
      song_id: 's', emotion_vector: { valence: .5, arousal: .2, tension: .1 },
      emotion_sources: { audio: { valence: 0, arousal: .2, tension: .1 } },
      audio_features: { bpm: 80, vocal_density: null, dynamic_range: .4, energy_curve: [] },
    });
    await previous.table('userEvents').add({ ts: 1, song_id: 's', action: 'like' });
    await previous.table('readingAnalyses').add({ ts: 1, text: '原始阅读证据' });
    await previous.table('settings').put({ key: 'app', value: { base_volume: 23 } });
    await previous.table('ltrModel').put({ id: 'local-ranking', feature_version: 'atmosphere-42-v1' });
    await previous.table('sceneStats').put({ scene_bucket: 'old', song_id: 's' });
    previous.close();
    await db.open();
    expect((await db.songs.get('s'))).toMatchObject({ tag_version: '', profile_status: 'pending' });
    expect((await db.songs.get('s'))?.last_tag_attempt).toBeUndefined();
    expect(await db.songProfiles.get('s')).toMatchObject({
      emotion_vector: null, audio_features: { bpm: 80, vocal_density: null },
    });
    expect((await db.songProfiles.get('s'))?.emotion_sources).toBeUndefined();
    expect(await db.userEvents.count()).toBe(1);
    expect(await db.readingAnalyses.count()).toBe(1);
    expect(await db.settings.get('app')).toMatchObject({ value: { base_volume: 23 } });
    expect(await db.ltrModel.count()).toBe(0);
    expect(await db.sceneStats.count()).toBe(0);
    await db.delete();
  });
});
