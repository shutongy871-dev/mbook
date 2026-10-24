import type { DecisionSnapshot, EmotionVector, Settings } from '@/core/shared/contracts';
import type { CandidateTrack } from './candidate-pool';
import { topsis } from './topsis';
import { localLearning } from './learning';
import { indicatorsFor, ruleScore, snapshotFor, type RankingContext } from './ranking-metrics';
import { mapTags } from '@/core/understanding/taxonomy';

export interface FeedbackContext {
  affinity: Map<string, number>;
  sceneMatch: Map<string, number>;
  completionRate: Map<string, number>;
  skipRate: Map<string, number>;
  quickSkipped: Set<string>;
  recentArtists: string[];
  recentSwitchCount: number;
  totalDecisions: number;
  playCounts: Map<string, number>;
  artistAffinity?: Map<string, number>;
  styleAffinity?: Map<string, number>;
  featurePreferences?: Map<string, number>;
  friendlinessBonus?: Map<string, number>;
  recentArtistCounts?: Map<string, number>;
}
export interface ScoreIndicators {
  semantic: number;
  emotion: number;
  friendliness: number;
  freshness: number;
  quality: number;
  popularity: number;
  preference: number;
  tag: number;
}
export interface RankedCandidate {
  candidate: CandidateTrack;
  finalScore: number;
  topsisScore: number;
  ruleScore: number;
  indicators: ScoreIndicators;
  mainReason: string;
  snapshot?: DecisionSnapshot;
  stage?: 'T0' | 'T1' | 'T2' | 'T3';
}

export function rankCandidates(candidates: CandidateTrack[], target: EmotionVector, targetTags: string[],
  settings: Settings, fb: FeedbackContext, lastPlayedAt: Map<string, number>, _eventCount: number,
  now: number, ctx: RankingContext = {}): RankedCandidate[] {
  if (!candidates.length) return [];
  const t0 = ctx.externalEnabled === false || !candidates.some(c => c.source !== 'builtin');
  const scored = candidates.map(candidate => {
    const indicators = indicatorsFor(candidate, target, targetTags, settings, fb, lastPlayedAt, now, ctx);
    if (t0) indicators.preference = 50;
    return { candidate, indicators, snapshot: snapshotFor(candidate, indicators, target, fb, ctx, now) };
  });
  const ordered = topsis(scored.map(s => ({ id: s.candidate.id, metrics: [
    s.indicators.semantic, s.indicators.emotion, s.indicators.friendliness, s.indicators.preference,
    s.indicators.tag, s.indicators.quality, s.indicators.popularity, s.indicators.freshness,
  ] })));
  const scores = new Map(ordered.map(s => [s.id, s.score]));
  return scored.map(s => {
    const top = scores.get(s.candidate.id) ?? 0;
    const rule = ruleScore(s.indicators, settings);
    const explore = t0 ? 0 : localLearning.explore(s.snapshot, fb.totalDecisions);
    const rank = t0 ? top : localLearning.predict(s.snapshot, top);
    const stage: RankedCandidate['stage'] = t0 ? 'T0' : localLearning.trained ? 'T3' :
      s.candidate.source !== 'builtin' && !s.candidate.bpm ? 'T1' : 'T2';
    let penalty = Number(fb.recentSwitchCount > 2) * 5 + Number(fb.quickSkipped.has(s.candidate.id)) * 10;
    if (fb.recentArtists.length >= 2 && fb.recentArtists.slice(-2).every(a => a === s.candidate.artist)) penalty += 8;
    const final = stage === 'T3' ? .4 * rank + .3 * top + .2 * rule + .1 * explore :
      .6 * top + .3 * rule + .1 * explore;
    return { ...s, finalScore: Math.max(0, final - penalty), topsisScore: top, ruleScore: rule, stage,
      mainReason: `${stage} · 情绪 ${Math.round(s.indicators.emotion)} · 语义 ${Math.round(s.indicators.semantic)} · 阅读友好 ${Math.round(s.indicators.friendliness)}` };
  }).sort((a, b) => b.finalScore - a.finalScore);
}

export function targetTagsFor(_target: EmotionVector, llmSceneTags: string[]): string[] {
  return mapTags(llmSceneTags);
}
