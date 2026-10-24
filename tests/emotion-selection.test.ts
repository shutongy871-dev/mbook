import { describe, expect, it } from 'vitest';
import { selectEmotionTrack, type EmotionCandidate } from '@/core/matching/emotion-selection';
import { scoreTextEmotions } from '@/core/understanding/emotion-scoring';

const track = (id: string, vector: Array<number | null>): EmotionCandidate => ({ id, vector });
const text = [1, 0, 0, 0, 0, 0, 0, 0];
const fallback = track('fallback', Array(8).fill(0));
const thresholds = { maxDifference: .1, maxDistance: .1, differenceStep: .2, distanceStep: .2 };

describe('adaptive eight-dimensional emotion selection', () => {
  it('tries initial thresholds, then alternates distance and per-dimension relaxation', () => {
    const result = selectEmotionTrack({
      text, candidates: [track('song', [.75, .25, 0, 0, 0, 0, 0, 0])],
      current: null, fallback, thresholds,
    });
    expect(result.reason).toBe('matched');
    expect(result.track.id).toBe('song');
    expect(result.attempts).toEqual([
      { maxDifference: .1, maxDistance: .1, passedCount: 0 },
      { maxDifference: .1, maxDistance: .1 + .2, passedCount: 0 },
      { maxDifference: .1 + .2, maxDistance: .1 + .2, passedCount: 0 },
      { maxDifference: .1 + .2, maxDistance: .1 + 2 * .2, passedCount: 1 },
    ]);
  });

  it('selects the highest cosine even when another passing song has a smaller distance', () => {
    const result = selectEmotionTrack({
      text,
      candidates: [track('closer', [.9, .1, 0, 0, 0, 0, 0, 0]),
        track('proportional', [.5, 0, 0, 0, 0, 0, 0, 0])],
      current: null, fallback, thresholds: { maxDifference: 1, maxDistance: 1 },
    });
    expect(result.track.id).toBe('proportional');
    expect(result.comparison?.cosine).toBeCloseTo(1);
    expect(result.attempts).toHaveLength(1);
  });

  it('continues relaxing until at least eight candidates pass when the pool allows it', () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      track(`song-${index}`, [1 - index * .08, 0, 0, 0, 0, 0, 0, 0]));
    const result = selectEmotionTrack({
      text, candidates, current: null, fallback, thresholds,
      minimumCandidates: 8,
    });
    expect(result.track.id).toBe('song-0');
    expect(result.attempts[0]!.passedCount).toBeLessThan(8);
    expect(result.attempts.at(-1)!.passedCount).toBeGreaterThanOrEqual(8);
  });

  it('uses distance then stable ID to resolve cosine ties independently of input order', () => {
    const far = track('far', [.5, 0, 0, 0, 0, 0, 0, 0]);
    const a = track('a', text), b = track('b', text);
    for (const candidates of [[far, b, a], [a, b, far]]) {
      expect(selectEmotionTrack({ text, candidates, current: null, fallback,
        thresholds: { maxDifference: 1, maxDistance: 1 } }).track.id).toBe('a');
    }
  });

  it('reaches exact mathematical limits and terminates with an eligible song', () => {
    const result = selectEmotionTrack({
      text: Array(8).fill(1), candidates: [fallback], current: null, fallback,
      thresholds: { maxDifference: 0, maxDistance: 0, differenceStep: .3, distanceStep: .7 },
    });
    expect(result.reason).toBe('matched');
    expect(result.attempts.at(-1)).toEqual({
      maxDifference: 1, maxDistance: Math.sqrt(8), passedCount: 1,
    });
    expect(result.attempts).toHaveLength(10);
    expect(result.comparison?.cosine).toBeNull();
  });

  it('keeps the current song for zero text and uses fallback when current is absent', () => {
    const current = track('current', text);
    const zero = scoreTextEmotions('他打开了门。').vector;
    const kept = selectEmotionTrack({ text: zero, candidates: [current], current, fallback });
    expect(kept).toMatchObject({ reason: 'keep_current', track: current, attempts: [] });
    expect(selectEmotionTrack({ text: zero, candidates: [], current: null, fallback }))
      .toMatchObject({ reason: 'fallback', track: fallback, attempts: [] });
  });

  it('does not mistake pairwise zero cosine for text with no emotion', () => {
    const orthogonal = track('orthogonal', [0, 1, 0, 0, 0, 0, 0, 0]);
    const result = selectEmotionTrack({ text, candidates: [orthogonal], current: null, fallback });
    expect(result.reason).toBe('matched');
    expect(result.comparison?.cosine).toBe(0);
  });

  it('uses keep/fallback for empty or incomplete pools without trying to invent profiles', () => {
    const current = track('current', text);
    expect(selectEmotionTrack({ text, candidates: [], current, fallback }).reason).toBe('keep_current');
    expect(selectEmotionTrack({ text, candidates: [
      track('missing', [null, 1, null, null, null, null, null, null]),
    ], current: null, fallback })).toMatchObject({ reason: 'fallback', attempts: [] });
  });

  it('validates bounds, positive steps, vector shape, duplicate IDs and termination budget', () => {
    for (const overrides of [
      { maxDifference: -1 }, { maxDistance: 3 }, { distanceStep: 0 },
      { differenceStep: -1 }, { distanceStep: NaN }, { differenceStep: 1e-12 },
    ]) {
      expect(() => selectEmotionTrack({ text, candidates: [], current: null, fallback,
        thresholds: overrides })).toThrow();
    }
    expect(() => selectEmotionTrack({ text: [1], candidates: [], current: null, fallback })).toThrow();
    expect(() => selectEmotionTrack({ text, candidates: [fallback, fallback], current: null, fallback }))
      .toThrow('候选音乐ID必须唯一');
  });
});
