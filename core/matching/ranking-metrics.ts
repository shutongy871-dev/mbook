import type { DecisionSnapshot, EmotionVector, Settings } from '@/core/shared/contracts';
import type { CandidateTrack } from './candidate-pool';
import type { FeedbackContext, ScoreIndicators } from './final-rank';
import { emotionScore } from './scores';
import { FEATURE_VERSION } from './learning';
import { featureAffinity, preferenceKeys } from '@/core/feedback/feature-preferences';

export interface RankingContext {
  embedding?: number[];
  embeddingModel?: string;
  state?: string;
  cpm?: number;
  contentType?: string;
  externalEnabled?: boolean;
}
export const clip = (v: number, max = 100) => Math.max(0, Math.min(max, v));

export function weightedJaccard(a: Record<string, number>, b: Record<string, number>): number {
  let intersection = 0, union = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    intersection += Math.min(a[key] ?? 0, b[key] ?? 0);
    union += Math.max(a[key] ?? 0, b[key] ?? 0);
  }
  return union ? intersection / union : 0;
}

export function cosine(a: number[] | undefined, b: number[] | undefined): number | null {
  if (!a?.length || !b || a.length !== b.length || ![...a, ...b].every(Number.isFinite)) return null;
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0) * b.reduce((s, v) => s + v * v, 0));
  return norm ? Math.max(-1, Math.min(1, a.reduce((s, v, i) => s + v * b[i]!, 0) / norm)) : null;
}

export function semanticSimilarity(c: CandidateTrack, ctx: RankingContext): number | null {
  return ctx.embeddingModel && ctx.embeddingModel === c.embeddingModel ?
    cosine(ctx.embedding, c.embedding) : null;
}

export function qualityScore(c: CandidateTrack): number {
  // 工程决策：AAC 96kbps 单声道内置节选按 128kbps 等效门槛；
  // 保留真实码率，不能把低码率伪写成 256/320。
  const equivalentBitrate = c.source === 'builtin' && c.audioFormat === 'aac' ? c.bitrateKbps * 4 / 3 : c.bitrateKbps;
  return 100 * (.5 * clip(equivalentBitrate / 320, 1) +
    .3 * (1 - (c.loadFailRate ?? 0)) + .2 * (c.sourceStability ?? 1));
}

export function indicatorsFor(c: CandidateTrack, target: EmotionVector, tags: string[],
  settings: Settings, fb: FeedbackContext, lastPlayed: Map<string, number>, now: number,
  ctx: RankingContext): ScoreIndicators {
  const tag = 100 * weightedJaccard(Object.fromEntries(tags.map(t => [t, 1])),
    c.tagConfidence ?? Object.fromEntries(c.tags.map(t => [t, 1])));
  const similarity = settings.ai_strength === 'off' ? null : semanticSimilarity(c, ctx);
  const [lo, hi] = settings.bpm_ranges.calm;
  const bpmPenalty = c.bpm ? clip(Math.max(lo - c.bpm, c.bpm - hi, 0), 40) : 0;
  const vocal = c.vocalDensity ?? (c.hasLyrics ? .65 : 0);
  const vocalPenalty = (settings.lyric_policy === 'any' ? 0 : vocal * 45) + vocal * (settings.vocal_penalty ?? 0) * 100;
  const energy = c.energyCurve ?? [];
  const jump = energy.slice(1).reduce((max, v, i) => Math.max(max, Math.abs(v - energy[i]!)), 0);
  const friendliness = clip((c.source !== 'builtin' && !c.bpm ? 70 :
    100 - bpmPenalty - vocalPenalty - (c.dynamicRange ?? 0) * 15 - jump * 20) +
    100 * (fb.friendlinessBonus?.get(c.id) ?? 0));
  const last = lastPlayed.get(c.id) ?? (c.lastMatchedAt || undefined);
  const hours = last == null ? 999 : Math.max(0, (now - last) / 3_600_000);
  const affinity = fb.affinity.get(c.id) ?? 0;
  const scene = fb.sceneMatch.get(c.id) ?? 0;
  const similar = fb.artistAffinity?.get(c.artist) ?? 0;
  const style = c.tags.length ? c.tags.reduce((s, t) => s + (fb.styleAffinity?.get(t) ?? 0), 0) / c.tags.length : 0;
  const feature = featureAffinity(preferenceKeys(c), fb.featurePreferences);
  const completion = fb.completionRate.get(c.id) ?? 0;
  const skip = fb.skipRate.get(c.id) ?? 0;
  const hasHistory = fb.affinity.has(c.id) || fb.playCounts.has(c.id) || !!similar || !!style || !!scene;
  return {
    semantic: similarity == null ? tag * .8 : similarity * 100,
    emotion: emotionScore(target, c.emotion),
    tag, friendliness,
    freshness: 100 * (1 - Math.exp(-hours / 12)) *
      clip(1 - .1 * (fb.recentArtistCounts?.get(c.artist) ?? 0), 1),
    quality: qualityScore(c),
    popularity: c.popularityScore ?? 40,
    preference: clip((hasHistory ? 40 * affinity + 20 * similar + 20 * scene + 10 * completion +
      10 * style - 30 * skip - 80 * Number(affinity <= -.2) : 50) + 20 * feature),
  };
}

export function ruleScore(m: ScoreIndicators, settings: Settings): number {
  // Engineering decision: transfer weight between semantic/tag, keeping total weight=1.
  const semanticWeight = { off: 0, standard: .28, strong: .35 }[settings.ai_strength];
  return semanticWeight * m.semantic + .24 * m.emotion + .2 * m.friendliness +
    .16 * m.preference + (.35 - semanticWeight) * m.tag + .05 * m.quality;
}

export function snapshotFor(c: CandidateTrack, m: ScoreIndicators, target: EmotionVector,
  fb: FeedbackContext, ctx: RankingContext, now: number): DecisionSnapshot {
  const metrics = [m.semantic, m.emotion, m.friendliness, m.freshness,
    m.quality, m.popularity, m.preference, m.tag].map(v => v / 100);
  // 8 scores + 17 song + 8 user + 11 context + 13 interactions = 57.
  // Stable order is the model contract; changing it requires FEATURE_VERSION bump.
  const song = [...c.emotion, c.emotionConfidence,
    clip(c.bpm / 200, 1), c.vocalDensity ?? Number(c.hasLyrics), c.dynamicRange ?? 0,
    clip(c.durationSec / 600, 1), clip(c.bitrateKbps / 320, 1), Number(c.source === 'builtin'),
    Number(semanticSimilarity(c, ctx) != null), clip((now - (c.addedAt ?? now)) / (30 * 86_400_000), 1)];
  const user = [fb.affinity.get(c.id) ?? 0, fb.sceneMatch.get(c.id) ?? 0,
    fb.completionRate.get(c.id) ?? 0, fb.skipRate.get(c.id) ?? 0,
    clip((fb.playCounts.get(c.id) ?? 0) / 20, 1), Number(fb.quickSkipped.has(c.id)),
    clip(fb.recentSwitchCount / 5, 1), Number(fb.recentArtists.at(-1) === c.artist)];
  const context = [...target,
    Number(ctx.state === 'focused'), clip((ctx.cpm ?? 0) / 900, 1), Number(ctx.contentType === 'novel')];
  const interactions = [...target.map((n, i) => n * c.emotion[i]!), metrics[0]! * metrics[7]!, metrics[1]! * metrics[6]!,
    metrics[2]! * context[9]!, user[0]! * metrics[1]!, user[1]! * metrics[7]!];
  return { version: FEATURE_VERSION, features: [...metrics, ...song, ...user, ...context, ...interactions]
    .map(v => Math.max(-1, Math.min(1, v))), indicators: metrics,
    bandit: [1, metrics[0]!, metrics[1]!, metrics[2]!, metrics[6]!,
      interactions.slice(0, 3).reduce((s, n) => s + n, 0) / 3,
      interactions.slice(3, 6).reduce((s, n) => s + n, 0) / 3,
      interactions.slice(6, 8).reduce((s, n) => s + n, 0) / 2] };
}
