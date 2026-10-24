import { EMOTION_DIMENSIONS } from './emotion-dictionary';
import { emotionCosineSimilarity } from './emotion-scoring';

export interface EmotionComparison {
  status: 'pass' | 'fail' | 'insufficient';
  cosine: number | null;
  euclideanDistance: number | null;
  rmse: number | null;
  maxDifference: number | null;
  differences: Array<number | null>;
  knownDimensions: number;
}

// 文字评分已将未命中维度补0，可直接参与完整八维比较。
// 显式null仍表示调用方缺失画像信息，不等同于词典未命中。
// SQL等效：SQRT(SUM(POWER(text_score-song_score,2)))、
// SQRT(AVG(POWER(text_score-song_score,2)))、MAX(ABS(...))。
export function compareEmotionVectors(
  text: readonly (number | null)[],
  song: readonly (number | null)[],
  maxAllowedDifference: number,
  maxAllowedDistance: number = Math.sqrt(EMOTION_DIMENSIONS.length),
): EmotionComparison {
  if (!Number.isFinite(maxAllowedDifference) || maxAllowedDifference < 0 || maxAllowedDifference > 1)
    throw new Error('最大单维差阈值必须在0～1之间');
  if (!Number.isFinite(maxAllowedDistance) || maxAllowedDistance < 0 ||
    maxAllowedDistance > Math.sqrt(EMOTION_DIMENSIONS.length))
    throw new Error('欧式距离阈值必须在0～√8之间');
  const valid = (vector: readonly (number | null)[]) =>
    vector.length === 8 && Array.from(vector).every(x => x === null ||
      (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1));
  if (!valid(text) || !valid(song)) throw new Error('画像必须是固定八维0～1数值或null');
  const differences = EMOTION_DIMENSIONS.map((_, i) =>
    text[i] == null || song[i] == null ? null : Math.abs(text[i]! - song[i]!));
  const known = differences.filter((x): x is number => x != null);
  const result: EmotionComparison = {
    status: 'insufficient', cosine: null, euclideanDistance: null, rmse: null, maxDifference: null,
    differences, knownDimensions: known.length,
  };
  // 即使部分未知，已知维度违反门槛也能证明不通过。
  if (known.some(x => x > maxAllowedDifference)) result.status = 'fail';
  if (known.length !== 8) return result;
  result.euclideanDistance = Math.hypot(...known);
  result.rmse = result.euclideanDistance / Math.sqrt(8);
  result.maxDifference = Math.max(...known);
  result.cosine = emotionCosineSimilarity(text, song);
  result.status = result.maxDifference > maxAllowedDifference ||
    result.euclideanDistance > maxAllowedDistance ? 'fail' : 'pass';
  return result;
}

// 门槛已通过的候选：余弦降序，同分时欧式距离升序；无方向排在有方向之后。
export function compareEmotionMatches(a: EmotionComparison, b: EmotionComparison): number {
  if (a.status !== 'pass' || b.status !== 'pass' || a.rmse == null || b.rmse == null)
    throw new Error('排序只接受完整八维且门槛通过的结果');
  return (b.cosine ?? -1) - (a.cosine ?? -1) || a.rmse - b.rmse;
}
