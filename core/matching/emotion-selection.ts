import { EMOTION_DIMENSIONS } from '@/core/understanding/emotion-dictionary';
import {
  compareEmotionVectors, compareEmotionMatches, type EmotionComparison,
} from '@/core/understanding/emotion-comparison';

const MAX_DISTANCE = Math.sqrt(EMOTION_DIMENSIONS.length);

export interface EmotionThresholds {
  maxDifference: number;
  maxDistance: number;
  differenceStep: number;
  distanceStep: number;
}

// 初始工程参数，可由调用方覆盖；尚未经真实歌曲/段落校准。
export const DEFAULT_EMOTION_THRESHOLDS: Readonly<EmotionThresholds> = {
  maxDifference: .2, maxDistance: .5, differenceStep: .1, distanceStep: .2,
};

export interface EmotionCandidate {
  id: string;
  vector: readonly (number | null)[];
}

export interface EmotionSelection<T> {
  track: T;
  reason: 'matched' | 'keep_current' | 'fallback';
  attempts: Array<{
    maxDifference: number;
    maxDistance: number;
    passedCount: number;
  }>;
  comparison: EmotionComparison | null;
}

// Selector纯函数。调用方传入已通过版权、人声、黑名单等过滤的候选、
// 仍可播放的当前歌，以及可播放的兜底歌；仅放宽情绪条件。
// SQL等效：WHERE MAX(ABS(text_i-song_i)) <= difference_threshold
// AND SQRT(SUM(POWER(text_i-song_i,2))) <= distance_threshold
// ORDER BY cosine DESC NULLS LAST, euclidean_distance ASC, song_id ASC LIMIT 1。
export function selectEmotionTrack<T extends EmotionCandidate>(input: {
  text: readonly number[];
  candidates: readonly T[];
  current: T | null;
  fallback: T;
  thresholds?: Partial<EmotionThresholds>;
  minimumCandidates?: number;
}): EmotionSelection<T> {
  const thresholds = { ...DEFAULT_EMOTION_THRESHOLDS, ...input.thresholds };
  // 复用画像/阈值校验；全零文字也需校验配置。
  compareEmotionVectors(input.text, input.text, thresholds.maxDifference, thresholds.maxDistance);
  if (!Array.from(input.text).every(x => typeof x === 'number'))
    throw new Error('文字画像必须是完整八维数字');
  for (const step of [thresholds.differenceStep, thresholds.distanceStep]) {
    if (!Number.isFinite(step) || step <= 0) throw new Error('阈值增量必须是正有限数');
  }
  const distanceRounds = Math.ceil((MAX_DISTANCE - thresholds.maxDistance) / thresholds.distanceStep);
  const differenceRounds = Math.ceil((1 - thresholds.maxDifference) / thresholds.differenceStep);
  // 防止错误配置造成几乎不增长的超长循环。
  if (Math.max(distanceRounds, differenceRounds) > 10_000)
    throw new Error('阈值增量过小，单项放宽次数不得超过10000');
  const attempts: EmotionSelection<T>['attempts'] = [];
  const keepOrFallback = (): EmotionSelection<T> => ({
    track: input.current ?? input.fallback,
    reason: input.current ? 'keep_current' : 'fallback',
    attempts, comparison: null,
  });
  if (input.text.every(value => value === 0)) return keepOrFallback();

  const ids = new Set<string>();
  const compared = input.candidates.map(track => {
    if (ids.has(track.id)) throw new Error('候选音乐ID必须唯一');
    ids.add(track.id);
    return { track, comparison: compareEmotionVectors(input.text, track.vector, 1, MAX_DISTANCE) };
  }).filter(item => item.comparison.knownDimensions === EMOTION_DIMENSIONS.length);
  if (!compared.length) return keepOrFallback();
  const minimumPassed = Math.min(compared.length,
    Math.max(1, Math.floor(input.minimumCandidates ?? 1)));

  let maxDifference = thresholds.maxDifference, maxDistance = thresholds.maxDistance;
  const trySelect = (): EmotionSelection<T> | null => {
    const passed = compared.filter(({ comparison }) =>
      comparison.maxDifference! <= maxDifference && comparison.euclideanDistance! <= maxDistance);
    attempts.push({ maxDifference, maxDistance, passedCount: passed.length });
    if (passed.length < minimumPassed) return null;
    passed.sort((a, b) => compareEmotionMatches(a.comparison, b.comparison) ||
      (a.track.id < b.track.id ? -1 : a.track.id > b.track.id ? 1 : 0));
    return { track: passed[0]!.track, reason: 'matched', attempts, comparison: passed[0]!.comparison };
  };
  let result = trySelect();
  if (result) return result;
  // 每一轮先增加欧式距离，再增加单维差；达到数学上限的项目不再重复增加。
  for (let round = 1; round <= Math.max(distanceRounds, differenceRounds); round++) {
    if (round <= distanceRounds) {
      maxDistance = round === distanceRounds ? MAX_DISTANCE :
        Math.min(MAX_DISTANCE, thresholds.maxDistance + round * thresholds.distanceStep);
      result = trySelect();
      if (result) return result;
    }
    if (round <= differenceRounds) {
      maxDifference = round === differenceRounds ? 1 :
        Math.min(1, thresholds.maxDifference + round * thresholds.differenceStep);
      result = trySelect();
      if (result) return result;
    }
  }
  return keepOrFallback();
}
