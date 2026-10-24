// 共用情绪距离。完整八指标口径见 ranking-metrics.ts。
import type { EmotionVector } from '@/core/shared/contracts';
import { emotionCosineSimilarity } from '@/core/understanding/emotion-scoring';

// 八维等权欧式距离，与筛选门槛同口径。
export function emotionDistance(a: EmotionVector, b: EmotionVector): number {
  return Math.hypot(...a.map((n, i) => n - b[i]!));
}

export function emotionScore(target: EmotionVector, song: EmotionVector): number {
  return 100 * (emotionCosineSimilarity(target, song) ?? 0);
}
