import type { CandidateTrack } from './candidate-pool';
import type { EmotionVector, Settings } from '@/core/shared/contracts';
import type { FeedbackContext } from './final-rank';
import { emotionDistance } from './scores';
import { semanticSimilarity, weightedJaccard, type RankingContext } from './ranking-metrics';

export type RecallChannel = 'emotion' | 'tag' | 'semantic' | 'preference' | 'freshness';
export function recallCandidates(pool: CandidateTrack[], target: EmotionVector, tags: string[],
  settings: Settings, fb: FeedbackContext, history: Map<string, number>, ctx: RankingContext) {
  const channels = new Map<string, RecallChannel[]>();
  const textTags = Object.fromEntries(tags.map(t => [t, 1]));
  const top = (score: (c: CandidateTrack) => number | null) => pool.map(c => ({ c, score: score(c) }))
    .filter((s): s is { c: CandidateTrack; score: number } => s.score != null)
    .sort((a, b) => b.score - a.score).slice(0, 20).map(s => s.c);
  const t0 = ctx.externalEnabled === false || !pool.some(c => c.source !== 'builtin');
  const lists: Array<[RecallChannel, CandidateTrack[]]> = [
    ['emotion', top(c => 1 - emotionDistance(target, c.emotion))],
  ];
  if (!t0) lists.push(
    ['tag', top(c => {
      const score = weightedJaccard(textTags, c.tagConfidence ?? Object.fromEntries(c.tags.map(t => [t, 1])));
      return score > 0 ? score : null;
    })],
    ['semantic', settings.ai_strength === 'off' ? [] : top(c => semanticSimilarity(c, ctx))],
    ['preference', top(c => (fb.affinity.get(c.id) ?? 0) + (fb.sceneMatch.get(c.id) ?? 0))],
    ['freshness', top(c => -(history.get(c.id) ?? c.lastMatchedAt ?? 0))],
  );
  for (const [channel, list] of lists) for (const c of list)
    channels.set(c.id, [...channels.get(c.id) ?? [], channel]);
  // Round-robin quotas preserve each channel when the union exceeds 60.
  const chosen = new Map<string, CandidateTrack>();
  for (let i = 0; i < 20 && chosen.size < 60; i++) {
    for (const [, list] of lists) {
      const c = list[i];
      if (c && chosen.size < 60) chosen.set(c.id, c);
    }
  }
  return { candidates: [...chosen.values()], channels };
}
