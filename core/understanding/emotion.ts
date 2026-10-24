import { EMOTION_DIMENSIONS, EMOTION_LABELS } from './emotion-dictionary';
import type { EmotionVector } from '@/core/shared/contracts';

export const ZERO_EMOTION: EmotionVector = Array(8).fill(0);
export const EMOTION_EMOJIS = ['😊', '🌧️', '🫧', '🌱', '😨', '🔥', '🌫️', '🏛️'];
export function isEmotionVector(value: unknown): value is EmotionVector {
  return Array.isArray(value) && value.length === 8 &&
    Array.from(value).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1);
}
export const MANUAL_EMOTIONS = EMOTION_DIMENSIONS.map((id, i) => ({
  id, label: EMOTION_LABELS[id], emoji: EMOTION_EMOJIS[i],
  vector: EMOTION_DIMENSIONS.map((_, j) => i === j ? .8 : 0),
}));
