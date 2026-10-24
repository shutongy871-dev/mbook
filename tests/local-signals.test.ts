import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { scoreTextEmotions } from '@/core/understanding/emotion-scoring';
import { EMOTION_DICTIONARY } from '@/core/understanding/emotion-dictionary';
import { computePopularity, refreshPopularity, validPlatformMetrics } from '@/core/matching/popularity';
import { db } from '@/core/db/dexie';
import type { Song, SongProfile } from '@/core/shared/contracts';

describe('local emotion dictionary', () => {
  it('covers the planned vocabulary and separates representative scenes', () => {
    expect(EMOTION_DICTIONARY.length).toBeGreaterThanOrEqual(2600);
    expect(scoreTextEmotions('恐惧').dimensions.fear.score).toBeGreaterThan(0);
    expect(scoreTextEmotions('喜悦').dimensions.joy.score).toBeGreaterThan(0);
    expect(scoreTextEmotions('悲伤').dimensions.sadness.score).toBeGreaterThan(0);
    expect(scoreTextEmotions('他打开门。').vector).toEqual(Array(8).fill(0));
  });
  it('counts overlapping words once and respects local negation', () => {
    expect(scoreTextEmotions('惴惴不安').matchedExpressionCount).toBe(1);
    expect(scoreTextEmotions('不再害怕').vector).toEqual(Array(8).fill(0));
    expect(scoreTextEmotions('并非开心').vector).toEqual(Array(8).fill(0));
  });
});

describe('daily popularity', () => {
  it('normalizes within the platform/window instead of comparing incompatible scales', () => {
    const rows = [
      { id: 'a', cohort: 'netease:today', platformProxy: 10 },
      { id: 'b', cohort: 'netease:today', platformProxy: 90 },
      { id: 'c', cohort: 'other:today', platformProxy: 10000 },
      { id: 'd', cohort: 'other:today', platformProxy: 90000 },
      { id: 'e', cohort: 'netease:yesterday', platformProxy: 1000 },
    ];
    const scores = computePopularity(rows);
    expect(scores[0]?.score).toBeCloseTo(scores[2]!.score);
    expect(scores[1]?.score).toBeCloseTo(scores[3]!.score);
    expect(scores[4]?.score).toBe(50);
  });
  it('consumes dated platform inputs and degrades stale/invalid counts to a proxy', async () => {
    await db.songs.clear(); await db.songProfiles.clear();
    const now = 10 * 86400000;
    const metrics = { provider: 'test-provider', window_end: now, plays7d: 100, exposures7d: 1000, playlistGrowth7d: -2 };
    expect(validPlatformMetrics(metrics, now)).toBe(true);
    expect(validPlatformMetrics({ ...metrics, plays7d: -1 }, now)).toBe(false);
    expect(validPlatformMetrics({ ...metrics, window_end: now + 1 }, now)).toBe(false);
    await db.songs.bulkPut([
      { song_id: 'a', popularity_raw: 10, popularity_metrics: metrics },
      { song_id: 'b', popularity_raw: 90, popularity_metrics: { ...metrics, plays7d: 200, exposures7d: 0, playlistGrowth7d: 20 } },
    ] as Song[]);
    await db.songProfiles.bulkPut([{ song_id: 'a' }, { song_id: 'b' }] as SongProfile[]);
    await refreshPopularity(now);
    expect(await db.songProfiles.get('a')).toMatchObject({ popularity_basis: 'platform_metrics' });
    expect((await db.songProfiles.get('a'))?.popularity_raw).toBeCloseTo(-.4);
    await refreshPopularity(now + 8 * 86400000);
    expect(await db.songProfiles.get('a')).toMatchObject({ popularity_basis: 'platform_proxy' });
  });
  it('standardizes columns before weighting and keeps missing/proxy data explicit', () => {
    const scores = computePopularity([
      { id: 'a', plays7d: 100, exposures7d: 1000, playlistGrowth7d: 0 },
      { id: 'b', plays7d: 200, exposures7d: 0, playlistGrowth7d: 20 },
      { id: 'c' }, { id: 'd', platformProxy: 99 },
    ]);
    expect(scores[0]!.raw).toBeCloseTo(-.4);
    expect(scores[1]!.raw).toBeCloseTo(.4);
    expect(scores[2]).toMatchObject({ score: 40, basis: 'neutral' });
    expect(scores[3]).toMatchObject({ score: 50, basis: 'platform_proxy' });
  });
  it('persists daily scores and does not refresh before the next day', async () => {
    await db.songs.clear(); await db.songProfiles.clear();
    await db.songs.bulkPut([{ song_id: 'a', primary_source: 'netease', popularity_raw: 10 },
      { song_id: 'b', primary_source: 'netease', popularity_raw: 90 }] as Song[]);
    await db.songProfiles.bulkPut([{ song_id: 'a' }, { song_id: 'b' }] as SongProfile[]);
    const now = 2 * 86400000;
    await refreshPopularity(now);
    const first = await db.songProfiles.get('a');
    expect(first?.popularity_score).toBeCloseTo(100 / (1 + Math.E));
    await db.songs.update('a', { popularity_raw: 100 });
    await refreshPopularity(now + 100);
    expect(await db.songProfiles.get('a')).toEqual(first);
    await refreshPopularity(now + 86400001);
    expect((await db.songProfiles.get('a'))?.popularity_score).toBeGreaterThan(50);
  });
});
