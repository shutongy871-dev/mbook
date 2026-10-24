import type { EmotionVector } from './contracts';

// SQL等效：八维分别CASE WHEN score<1/3 THEN 0 WHEN score>2/3 THEN 2 ELSE 1 END。
export function sceneBucket(emotion: EmotionVector | null, contentType = 'article'): string {
  if (!emotion || emotion.every(n => n === 0)) return `unknown_${contentType}`;
  const bucket = (n: number) => n < 1 / 3 ? 0 : n > 2 / 3 ? 2 : 1;
  return `e8_${emotion.map(bucket).join('')}_${contentType}`;
}
