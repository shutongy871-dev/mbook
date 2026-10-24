import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db/dexie';
import { settingsRepo } from '@/core/db/settings.repo';
import { FEATURE_VERSION, LocalLearning, linUcb, trainLogistic, updateBandit } from '@/core/matching/learning';
import { indicatorsFor, semanticSimilarity, snapshotFor, weightedJaccard } from '@/core/matching/ranking-metrics';
import { filterReason } from '@/core/matching/hard-filter';
import { recallCandidates } from '@/core/matching/recall';
import { rankCandidates, type FeedbackContext } from '@/core/matching/final-rank';
import type { CandidateTrack } from '@/core/matching/candidate-pool';
import type { UserEvent } from '@/core/shared/contracts';
const target = [.2, 0, .3, .1, 0, 0, 0, 0];
const candidate: CandidateTrack = { id: 's', source: 'netease', title: 'test', artist: 'a', url: '',
  emotion: target, emotionConfidence: 1, tags: ['平静舒缓'], bpm: 80, hasLyrics: false,
  bitrateKbps: 320, popularityRaw: 0, durationSec: 120, embeddingModel: 'same', embedding: [1, 0] };
const fb: FeedbackContext = { affinity: new Map(), sceneMatch: new Map(), completionRate: new Map(),
  skipRate: new Map(), quickSkipped: new Set(), recentArtists: [], recentSwitchCount: 0,
  totalDecisions: 0, playCounts: new Map() };
beforeEach(async () => { await db.userEvents.clear(); await db.ltrModel.clear(); await db.settings.clear(); });

describe('numerical ranking contracts', () => {
  it('uses confidence weighted overlap and only compares the same embedding space', () => {
    expect(weightedJaccard({ a: 1, b: .2 }, { a: .5, c: 1 })).toBeCloseTo(.5 / 2.2);
    expect(semanticSimilarity(candidate, { embeddingModel: 'other', embedding: [1, 0] })).toBeNull();
    expect(semanticSimilarity(candidate, { embeddingModel: 'same', embedding: [0, 1] })).toBe(0);
    expect(semanticSimilarity(candidate, { embeddingModel: 'same', embedding: [1, 0] })).toBe(1);
  });
  it('hard filters rights, duration, load quality and vocals regardless of emotion match', async () => {
    const s = await settingsRepo.get();
    expect(filterReason(candidate, s)).toBeNull();
    expect(filterReason({ ...candidate, copyrightAvailable: false }, s)).toBe('copyright');
    expect(filterReason({ ...candidate, playable: false }, s)).toBe('unplayable');
    expect(filterReason({ ...candidate, durationSec: 20 }, s)).toBe('duration');
    expect(filterReason({ ...candidate, loadFailRate: 1, sourceStability: 0 }, s)).toBe('quality');
    expect(filterReason({ ...candidate, vocalDensity: .9 }, s)).toBe('vocal_density');
  });
  it('uses the planned vocal ceilings and conservatively filters unknown vocals with lyrics', async () => {
    const settings = await settingsRepo.get();
    for (const [lyric_policy, ceiling] of [
      ['instrumental_only', .2], ['instrumental_preferred', .4], ['any', .8],
    ] as const) {
      const configured = { ...settings, lyric_policy };
      expect(filterReason({ ...candidate, vocalDensity: ceiling }, configured)).toBeNull();
      expect(filterReason({ ...candidate, vocalDensity: ceiling + .01 }, configured)).toBe('vocal_density');
    }
    expect(filterReason({ ...candidate, hasLyrics: true, vocalDensity: null }, settings)).toBe('vocal_density');
  });
  it('recalls a semantically relevant outlier and preserves channel explanations', async () => {
    const settings = { ...await settingsRepo.get(), ai_strength: 'standard' as const };
    const pool = Array.from({ length: 100 }, (_, i) => ({ ...candidate, id: String(i),
      emotion: i === 99 ? [0, 0, 0, 0, 1, 1, 1, 1] : target,
      embedding: i === 99 ? [1, 0] : [0, 1] }));
    const result = recallCandidates(pool, target, candidate.tags, settings, fb, new Map(),
      { embedding: [1, 0], embeddingModel: 'same', externalEnabled: true });
    expect(result.candidates.some(c => c.id === '99')).toBe(true);
    expect(result.channels.get('99')).toContain('semantic');
    expect(result.candidates.length).toBeLessThanOrEqual(60);
  });
  it('produces 57 bounded features, 8 indicators and honors AI strength', async () => {
    const settings = { ...await settingsRepo.get(), ai_strength: 'standard' as const };
    const ctx = { embedding: [1, 0], embeddingModel: 'same', cpm: 450, state: 'focused' };
    const scores = indicatorsFor(candidate, target, [], settings, fb, new Map(), Date.now(), ctx);
    expect(scores.semantic).toBe(100);
    const snapshot = snapshotFor(candidate, scores, target, fb, ctx, Date.now());
    expect(snapshot.features).toHaveLength(57);
    expect(snapshot.indicators).toHaveLength(8);
    expect(snapshot.features.every(v => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
    const off = rankCandidates([candidate], target, [], { ...settings, ai_strength: 'off' }, fb, new Map(), 0, Date.now(), ctx)[0]!;
    const strong = rankCandidates([candidate], target, [], { ...settings, ai_strength: 'strong' }, fb, new Map(), 0, Date.now(), ctx)[0]!;
    expect(strong.ruleScore).toBeGreaterThan(off.ruleScore);
  });
});

describe('local learned ranking', () => {
  const features = (positive: boolean) => Array.from({ length: 57 }, (_, i) => i === 0 ? (positive ? 1 : -1) : 0);
  const snap = (positive: boolean) => ({ version: FEATURE_VERSION, features: features(positive),
    bandit: [1, positive ? 1 : -1, 0, 0, 0, 0, 0, 0], indicators: Array(8).fill(0) });
  it('learns opposite outcomes instead of reusing TOPSIS', () => {
    const fit = trainLogistic(Array.from({ length: 200 }, (_, i) =>
      ({ x: features(i % 2 === 0), y: i % 2 === 0 ? 1 : 0, weight: 1 })));
    expect(fit.weights[0]).toBeGreaterThan(1);
    expect(Math.abs(fit.bias)).toBeLessThan(.01);
  });
  it('updates full covariance and rewards in LinUCB', () => {
    const matrix = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => Number(i === j)));
    const b = Array(8).fill(0), x = [1, .5, 0, 0, 0, 0, 0, 0];
    const positive = updateBandit(matrix, b, x, 1);
    const negative = updateBandit(matrix, b, x, -1);
    expect(positive.inverse[0]![1]).not.toBe(0);
    expect(linUcb(positive.inverse, positive.b, x, 100)).toBeGreaterThan(linUcb(negative.inverse, negative.b, x, 100));
  });
  it('trains at 200/400 valid samples and restores predictions without replaying rewards', async () => {
    const add = async (count: number) => {
      const events: UserEvent[] = Array.from({ length: count }, (_, i) => ({
        ts: Date.now(), window_id: 'w', scene_bucket: 'scene', song_id: 's',
        action: i % 2 === 0 ? 'like' : 'dislike', context_features: {}, decision: snap(i % 2 === 0),
      }));
      await db.userEvents.bulkAdd(events);
    };
    const model = new LocalLearning();
    await add(199); await model.hydrate();
    expect(model.trained).toBe(false);
    await add(1); await model.observe();
    expect(model.trained).toBe(true);
    const predicted = model.predict(snap(true), 50);
    expect(predicted).toBeGreaterThan(80);
    const state200 = await db.ltrModel.get('local-ranking');
    const restarted = new LocalLearning(); await restarted.hydrate();
    expect(restarted.predict(snap(true), 50)).toBe(predicted);
    expect((await db.ltrModel.get('local-ranking'))?.bandit_b).toEqual(state200?.bandit_b);
    await add(199); await restarted.observe();
    expect((await db.ltrModel.get('local-ranking'))?.weights).toEqual(state200?.weights);
    await add(1); await restarted.observe();
    const state400 = await db.ltrModel.get('local-ranking');
    expect(state400?.sample_count).toBe(400);
    expect(state400?.weights).not.toEqual(state200?.weights);
  });
});
