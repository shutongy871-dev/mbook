import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EMOTION_DICTIONARY, EMOTION_DIMENSIONS, EMOTION_DICTIONARY_COUNT,
} from '@/core/understanding/emotion-dictionary';
import { emotionCosineSimilarity, scoreTextEmotions } from '@/core/understanding/emotion-scoring';

describe('eight-dimensional local emotion scoring', () => {
  it('exports every dictionary entry and all eight scores without drift', () => {
    const csv = readFileSync(new URL('../core/understanding/emotion-dictionary.csv', import.meta.url), 'utf8');
    const cell = (value: unknown) => {
      const text = value == null ? '' : String(value);
      return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    expect(csv).toBe([
      ['term', ...EMOTION_DIMENSIONS].join(','),
      ...EMOTION_DICTIONARY.map(entry => [entry.term, ...EMOTION_DIMENSIONS.map(d => entry.scores[d])]
        .map(cell).join(',')),
      '',
    ].join('\n'));
  });
  it('has explicit, unique, bounded vocabulary covering all eight dimensions', () => {
    expect(EMOTION_DICTIONARY_COUNT).toBeGreaterThanOrEqual(2000);
    expect(new Set(EMOTION_DICTIONARY.map(e => e.term)).size).toBe(EMOTION_DICTIONARY_COUNT);
    for (const dimension of EMOTION_DIMENSIONS) {
      expect(EMOTION_DICTIONARY.some(e => e.scores[dimension] > 0)).toBe(true);
    }
    for (const entry of EMOTION_DICTIONARY) {
      expect(Object.keys(entry.scores)).toEqual([...EMOTION_DIMENSIONS]);
      expect(Object.values(entry.scores).some(score => score > 0)).toBe(true);
      for (const score of Object.values(entry.scores)) expect([0, .25, .5, .75, 1]).toContain(score);
    }
  });

  it.each([
    ['开心', 'joy', .5], ['遗憾', 'sadness', .25], ['悲痛欲绝', 'sadness', 1],
    ['温柔呵护', 'tenderness', .75], ['充满希望', 'hope', .75],
    ['胆怯', 'fear', .25], ['魂飞魄散', 'fear', 1], ['怒不可遏', 'anger', 1],
    ['扑朔迷离', 'mystery', .75], ['庄严肃穆', 'solemnity', .75],
  ] as const)('scores %s directly in %s', (text, dimension, score) => {
    expect(scoreTextEmotions(text).dimensions[dimension].score).toBe(score);
  });

  it('keeps mixed emotions independent instead of averaging them into calm', () => {
    const result = scoreTextEmotions('她非常悲伤，但对明天仍充满希望。');
    expect(result.dimensions.sadness.score).toBe(.75);
    expect(result.dimensions.hope.score).toBe(.75);
    expect(result.dimensions.joy).toMatchObject({ score: 0, unknown: true });
  });

  it('supports one expression contributing to multiple dimensions', () => {
    const result = scoreTextEmotions('悲喜交加');
    expect(result.matchedExpressionCount).toBe(1);
    expect(result.dimensions.joy.score).toBe(.5);
    expect(result.dimensions.sadness.score).toBe(.5);
  });

  it.each([
    ['有点悲伤', .25], ['略微悲伤', .25], ['十分悲伤', .75],
    ['非常地悲伤', .75], ['极其悲痛欲绝', 1],
  ])('applies degree and caps scores: %s', (text, score) => {
    const result = scoreTextEmotions(text).dimensions.sadness;
    expect(result.score).toBe(score);
    expect(result.strongestEvidence?.expression).toBe(text);
  });

  it.each(['不开心', '非开心', '并不开心', '没有感到非常开心', '不再害怕', '并非非常悲伤'])(
    'retains negation evidence without creating an opposite emotion: %s', text => {
      const result = scoreTextEmotions(text);
      expect(EMOTION_DIMENSIONS.every(d => result.dimensions[d].unknown)).toBe(true);
      const evidence = EMOTION_DIMENSIONS.flatMap(d => result.dimensions[d].evidence);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ expression: text, excluded: 'negated', score: 0 });
    },
  );

  it.each(['不是不开心', '不得不开心', '不无悲伤'])(
    'marks complex negation unsupported rather than assigning certainty: %s', text => {
      const result = scoreTextEmotions(text);
      expect(EMOTION_DIMENSIONS.flatMap(d => result.dimensions[d].evidence)[0]?.excluded)
        .toBe('complex_negation');
      expect(result.vector).toEqual(Array(8).fill(0));
    },
  );

  it('does not carry modifiers across clauses or sentences', () => {
    expect(scoreTextEmotions('并不开心，但非常悲伤。').dimensions.sadness.score).toBe(.75);
    expect(scoreTextEmotions('他没有离开，非常悲伤。').dimensions.sadness.score).toBe(.75);
    expect(scoreTextEmotions('非常。悲伤').dimensions.sadness.score).toBe(.5);
    expect(scoreTextEmotions('没有。他开心。').dimensions.joy.score).toBe(.5);
  });

  it('means valid strengths and retains repeated contributions separately', () => {
    const result = scoreTextEmotions('悲伤。悲伤。悲痛欲绝。悲痛欲绝。');
    expect(result.matchedExpressionCount).toBe(4);
    expect(result.dimensions.sadness).toMatchObject({
      score: .75, sum: 3, hitCount: 4, validHitCount: 4, sentenceCount: 4,
    });
    expect(scoreTextEmotions('悲伤。'.repeat(10)).dimensions.sadness).toMatchObject({ score: .5, sum: 5 });
    expect(scoreTextEmotions('悲伤悲伤').dimensions.sadness.score).toBe(.5);
    expect(scoreTextEmotions('惴惴不安').matchedExpressionCount).toBe(1);
  });

  it('preserves positive evidence when a different mention is negated', () => {
    const result = scoreTextEmotions('他并不悲伤。她非常悲伤。').dimensions.sadness;
    expect(result).toMatchObject({ score: .75, hitCount: 2, validHitCount: 1, sentenceCount: 1 });
    expect(result.strongestEvidence?.sentence).toBe('她非常悲伤。');
  });

  it('preserves source offsets, including emoji, whitespace and newlines', () => {
    const text = '🙂他开心。\n  她非常悲伤！';
    const evidence = scoreTextEmotions(text).dimensions.sadness.strongestEvidence!;
    expect(text.slice(evidence.start, evidence.end)).toBe('非常悲伤');
    expect(evidence.sentence).toBe('  她非常悲伤！');
    expect(evidence.sentenceIndex).toBe(1);
  });

  it.each(['', '他打开了门。', '！！！……', '父亲在未来的某一天出门。'])(
    'pads missing evidence with zero while retaining evidence metadata: %s', text => {
      const result = scoreTextEmotions(text);
      expect(result.matchedExpressionCount).toBe(0);
      expect(result.vector).toEqual(Array(8).fill(0));
      for (const dimension of EMOTION_DIMENSIONS) {
        expect(result.dimensions[dimension]).toMatchObject({
          score: 0, sum: 0, unknown: true, evidence: [], strongestEvidence: null,
        });
      }
    },
  );

  it('means ten adjusted keywords independently into the eight-dimensional vector', () => {
    const result = scoreTextEmotions('开心，悲伤，温柔，希望，害怕，愤怒，神秘，庄严，有点悲伤，非常开心。');
    expect(result.matchedExpressionCount).toBe(10);
    expect(result.vector).toEqual([.625, .375, .5, .5, .5, .5, .5, .5]);
    expect(result.vector).toEqual(EMOTION_DIMENSIONS.map(d => result.dimensions[d].score));
    expect(scoreTextEmotions('极其悲痛欲绝。极其悲痛欲绝。').dimensions.sadness).toMatchObject({ score: 1, sum: 2 });
  });

  it('does not treat the 不 inside an emotional word as an external negation', () => {
    expect(scoreTextEmotions('不满').dimensions.anger.score).toBe(.25);
    expect(scoreTextEmotions('不安').dimensions.fear.score).toBe(.5);
    expect(scoreTextEmotions('非常不安').dimensions.fear.score).toBe(.75);
    expect(scoreTextEmotions('并非不安').dimensions.fear.score).toBe(0);
  });

  it('compares bounded complete vectors while rejecting unknown and zero directions', () => {
    const a = [.5, .5, 0, 0, 0, 0, 0, 0];
    const b = [.25, .25, 0, 0, 0, 0, 0, 0];
    expect(emotionCosineSimilarity(a, b)).toBeCloseTo(1);
    expect(emotionCosineSimilarity([1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0, 0])).toBe(0);
    expect(emotionCosineSimilarity(a, scoreTextEmotions('他打开了门').vector)).toBeNull();
    expect(emotionCosineSimilarity(a.slice(1), b)).toBeNull();
    expect(emotionCosineSimilarity([Infinity, 0, 0, 0, 0, 0, 0, 0], b)).toBeNull();
    expect(emotionCosineSimilarity([-1, 0, 0, 0, 0, 0, 0, 0], b)).toBeNull();
    expect(emotionCosineSimilarity(Array(8).fill(Number.MAX_VALUE), Array(8).fill(1))).toBeNull();
    expect(emotionCosineSimilarity(Array(8).fill(0), b)).toBeNull();
  });

  it('computes cosine directly from text with only one emotional dimension', () => {
    const text = scoreTextEmotions('有点悲伤。非常悲伤。').vector;
    expect(text).toEqual([0, .5, 0, 0, 0, 0, 0, 0]);
    expect(emotionCosineSimilarity(text, [0, .8, 0, 0, 0, 0, 0, 0])).toBeCloseTo(1);
    expect(emotionCosineSimilarity(text, [0, .5, .5, 0, 0, 0, 0, 0])).toBeCloseTo(1 / Math.sqrt(2));
  });
});
