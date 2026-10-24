import { describe, expect, it } from 'vitest';
import { compareEmotionVectors, compareEmotionMatches } from '@/core/understanding/emotion-comparison';
import { scoreTextEmotions } from '@/core/understanding/emotion-scoring';

describe('bounded eight-dimensional emotion comparison', () => {
  const text = [0, .8, .4, .6, 0, 0, 0, 0];
  it('distinguishes proportional but weaker music despite perfect cosine', () => {
    const same = compareEmotionVectors(text, text, .2);
    const weak = compareEmotionVectors(text, [0, .2, .1, .15, 0, 0, 0, 0], .2);
    expect(same).toMatchObject({ status: 'pass', rmse: 0, maxDifference: 0, knownDimensions: 8 });
    expect(weak.cosine).toBeCloseTo(1);
    expect(weak.maxDifference).toBeCloseTo(.6);
    expect(weak.euclideanDistance).toBeCloseTo(Math.sqrt(.6 ** 2 + .3 ** 2 + .45 ** 2));
    expect(weak.rmse).toBeCloseTo(Math.sqrt((.6 ** 2 + .3 ** 2 + .45 ** 2) / 8));
    expect(weak.status).toBe('fail');
  });
  it('rejects a single excessive emotion even when overall RMSE is small', () => {
    const song = [...text]; song[4] = .4;
    const result = compareEmotionVectors(text, song, .3);
    expect(result.rmse).toBeLessThan(.15);
    expect(result.status).toBe('fail');
  });
  it('accepts the threshold boundary and ranks passed results by cosine then distance', () => {
    const a = compareEmotionVectors(text, text, .2);
    const b = compareEmotionVectors(text, [0, .75, .45, .55, 0, 0, 0, 0], .2);
    expect(compareEmotionVectors(Array(8).fill(0), [.2, 0, 0, 0, 0, 0, 0, 0], .2).status).toBe('pass');
    expect(compareEmotionMatches(a, b)).toBeLessThan(0);
  });
  it('requires both single-dimension and Euclidean thresholds to pass', () => {
    const song = [0, .6, .2, .4, 0, 0, 0, 0];
    const result = compareEmotionVectors(text, song, .3, .3);
    expect(result.maxDifference).toBeLessThan(.3);
    expect(result.euclideanDistance).toBeGreaterThan(.3);
    expect(result.status).toBe('fail');
    expect(compareEmotionVectors(text, song, .3, result.euclideanDistance!).status).toBe('pass');
    for (const distance of [-1, 3, Infinity, NaN]) {
      expect(() => compareEmotionVectors(text, song, .3, distance)).toThrow();
    }
  });
  it('computes complete distances and cosine from zero-padded text evidence', () => {
    const vector = scoreTextEmotions('悲伤').vector;
    const result = compareEmotionVectors(vector, [0, .8, .2, 0, 0, 0, 0, 0], .4);
    expect(result.status).toBe('pass');
    expect(result.knownDimensions).toBe(8);
    expect(result.differences).toEqual([0, .8 - .5, .2, 0, 0, 0, 0, 0]);
    expect(result.maxDifference).toBeCloseTo(.3);
    expect(result.euclideanDistance).toBeCloseTo(Math.sqrt(.3 ** 2 + .2 ** 2));
    expect(result.rmse).toBeCloseTo(Math.sqrt((.3 ** 2 + .2 ** 2) / 8));
    expect(result.cosine).toBeCloseTo(.8 / Math.hypot(.8, .2));
    const same = compareEmotionVectors(vector, vector, .4);
    expect(compareEmotionMatches(same, result)).toBeLessThan(0);
  });
  it('preserves explicitly missing profile data from callers', () => {
    const partial = compareEmotionVectors([null, .5, null, null, null, null, null, null], text, .4);
    expect(partial).toMatchObject({
      status: 'insufficient', knownDimensions: 1, cosine: null, euclideanDistance: null,
      rmse: null, maxDifference: null,
    });
    expect(partial.differences[0]).toBeNull();
    expect(() => compareEmotionMatches(partial, partial)).toThrow();
    expect(compareEmotionVectors([null, 1, null, null, null, null, null, null],
      [null, 0, null, null, null, null, null, null], .2).status).toBe('fail');
  });
  it('keeps known zero different from unknown and rejects malformed input', () => {
    expect(compareEmotionVectors(Array(8).fill(0), Array(8).fill(0), .2))
      .toMatchObject({ status: 'pass', cosine: null, euclideanDistance: 0, rmse: 0 });
    const noHits = compareEmotionVectors(scoreTextEmotions('他打开了门。').vector, text, 1);
    expect(noHits).toMatchObject({ status: 'pass', cosine: null, knownDimensions: 8 });
    expect(noHits.euclideanDistance).toBeCloseTo(Math.hypot(...text));
    for (const vector of [[1], Array(8).fill(2), Array(8).fill(NaN), Array(8)]) {
      expect(() => compareEmotionVectors(vector, text, .2)).toThrow();
    }
    for (const threshold of [-1, 2, NaN]) expect(() => compareEmotionVectors(text, text, threshold)).toThrow();
  });
  it('repeating text changes evidence totals without changing matching intensity', () => {
    const passage = '有点悲伤。非常悲伤。';
    const a = scoreTextEmotions(passage), b = scoreTextEmotions(passage.repeat(10));
    expect(a.dimensions.sadness.score).toBe(.5);
    expect(b.vector).toEqual(a.vector);
    expect(b.dimensions.sadness.sum).toBe(10 * a.dimensions.sadness.sum);
    expect(a).not.toHaveProperty('macro');
  });
});
