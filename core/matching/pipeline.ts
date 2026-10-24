// 八维选歌：非情绪硬过滤 → 单维差/欧式门槛交替放宽 → 余弦排序。
// 降级铁律：外部曲库/画像/反馈全部缺失时，CC0 10 首 + 中性反馈上下文仍可出结果。

import type { EmotionVector, Settings } from '@/core/shared/contracts';
import { assemblePool } from './candidate-pool';
import type { RecallChannel } from './recall';
import { selectEmotionTrack, type EmotionSelection, type EmotionCandidate } from './emotion-selection';
import { compareEmotionVectors, compareEmotionMatches } from '@/core/understanding/emotion-comparison';
import { emotionScore } from './scores';
import { filterReason } from './hard-filter';
import { indicatorsFor, snapshotFor, type RankingContext } from './ranking-metrics';
import {
  type FeedbackContext,
  type RankedCandidate,
  targetTagsFor,
} from './final-rank';

export interface SelectResult {
  ranked: RankedCandidate[]; // 全部候选排序（含当前歌，供 score_gain 对比）
  targets: RankedCandidate[];
  best: RankedCandidate | null; // 可切/可播最佳（排除当前歌、30 分钟内播过）
  channels?: Map<string, RecallChannel[]>;
  filteredOut?: Array<{ id: string; reason: string }>;
  selection?: EmotionSelection<EmotionCandidate>;
}

const RECENT_COOLDOWN_MS = 30 * 60_000;
const MIN_EMOTION_RECALL = 8;
const ROTATION_TOP_K = 5;

export interface SelectInput {
  target: EmotionVector;
  llmSceneTags: string[];
  settings: Settings;
  feedback: FeedbackContext;
  lastPlayedAt: Map<string, number>;
  currentTrackId: string | null;
  externalEnabled: boolean;
  blacklist: Set<string>; // 点踩拉黑（CC0 内存态 + 外部 DB 已过滤）
  eventCount: number;
  now: number;
  context?: RankingContext;
  excludeCurrent?: boolean; // 用户下一首/自然播完，排除当前；自动决策保留当前。
  neteaseConnected?: boolean; // 同步确认登录后，优先在网易云候选内做八维匹配。
}

export async function selectSongs(input: SelectInput): Promise<SelectResult> {
  let pool = await assemblePool(input.blacklist);
  // externalEnabled=false 时剔除外部候选（CC0 永远保底）
  if (!input.externalEnabled) {
    pool = pool.filter((c) => c.source === 'builtin');
  }
  const filteredOut: Array<{ id: string; reason: string }> = [];
  pool = pool.filter(c => {
    const reason = filterReason(c, input.settings);
    if (reason) filteredOut.push({ id: c.id, reason });
    return !reason;
  });
  const context = { ...input.context, externalEnabled: input.externalEnabled };
  const targetTags = targetTagsFor(input.target, input.llmSceneTags);
  let eligible = pool.filter(c => {
    const last = input.lastPlayedAt.get(c.id) ?? c.lastMatchedAt;
    const recent = last != null && last > 0 && input.now - last < RECENT_COOLDOWN_MS;
    if (recent && c.id !== input.currentTrackId) filteredOut.push({ id: c.id, reason: 'repeat_cooldown' });
    return c.id === input.currentTrackId ? !input.excludeCurrent : !recent;
  });
  if (!eligible.some(c => c.id !== input.currentTrackId)) {
    eligible = pool.filter(c => c.source === 'builtin' &&
      (!input.excludeCurrent || c.id !== input.currentTrackId));
  }
  // 辅助指标只记录供检查，TOPSIS/学习排序不再介入选歌。
  const ranked: RankedCandidate[] = pool.map(candidate => {
    const indicators = indicatorsFor(candidate, input.target, targetTags, input.settings,
      input.feedback, input.lastPlayedAt, input.now, context);
    const score = emotionScore(input.target, candidate.emotion);
    return { candidate, indicators, finalScore: score, topsisScore: 0, ruleScore: score,
      snapshot: snapshotFor(candidate, indicators, input.target, input.feedback, context, input.now),
      mainReason: '八维情绪余弦相似度' };
  });
  const asVector = (c: typeof pool[number]) => ({ id: c.id, vector: c.emotion });
  const netease = input.externalEnabled && input.neteaseConnected ?
    eligible.filter(c => c.source === 'netease' && c.emotion.some(n => n > 0)) : [];
  const preferNetease = netease.length > 0;
  // Keep NetEase first, but fill a small library with built-ins so the emotion
  // selector can reach a useful recall size instead of stopping at 1-2 songs.
  const matchingPool = preferNetease && netease.length < MIN_EMOTION_RECALL ?
    [...netease, ...eligible.filter(c => c.source !== 'netease')] :
    preferNetease ? netease : eligible;
  const current = input.excludeCurrent ? null : eligible.find(c => c.id === input.currentTrackId) ?? null;
  const fallback = netease[0] ?? eligible.find(c => c.id === 'cc10') ?? eligible.find(c => c.source === 'builtin') ?? eligible[0];
  if (!fallback) return { ranked, targets: [], best: null, filteredOut };
  const selection = selectEmotionTrack({
    text: input.target, candidates: matchingPool.filter(c => c.emotion.some(n => n > 0)).map(asVector),
    current: current ? asVector(current) : null, fallback: asVector(fallback),
    minimumCandidates: MIN_EMOTION_RECALL,
  });
  const last = selection.attempts.at(-1);
  const ids = new Set(eligible.map(c => c.id));
  const matchingIds = new Set(matchingPool.map(c => c.id));
  const targets = ranked.filter(r => ids.has(r.candidate.id)).sort((a, b) => {
    if (matchingIds.has(a.candidate.id) !== matchingIds.has(b.candidate.id))
      return Number(matchingIds.has(b.candidate.id)) - Number(matchingIds.has(a.candidate.id));
    if (preferNetease && a.candidate.source !== b.candidate.source)
      return a.candidate.source === 'netease' ? -1 : 1;
    const compare = (r: RankedCandidate) => compareEmotionVectors(input.target, r.candidate.emotion,
      last?.maxDifference ?? 1, last?.maxDistance ?? Math.sqrt(8));
    const ca = compare(a), cb = compare(b);
    if (ca.status === 'pass' && cb.status === 'pass')
      return compareEmotionMatches(ca, cb) || a.candidate.id.localeCompare(b.candidate.id);
    return Number(cb.status === 'pass') - Number(ca.status === 'pass') ||
      (ca.euclideanDistance ?? Infinity) - (cb.euclideanDistance ?? Infinity);
  });
  const passedCount = Math.min(last?.passedCount ?? 0, targets.length);
  const topMatches = targets.slice(0, Math.min(ROTATION_TOP_K, passedCount));
  const first = topMatches[0];
  // Do not churn when the current song remains the closest match. Otherwise,
  // rotate within the top five by oldest play time; never-played songs come first.
  const rotatedMatch = first?.candidate.id === input.currentTrackId ? first :
    topMatches.map((candidate, index) => ({ candidate, index,
      playedAt: input.lastPlayedAt.get(candidate.candidate.id) ?? candidate.candidate.lastMatchedAt ?? 0 }))
      .sort((a, b) => a.playedAt - b.playedAt || a.index - b.index)[0]?.candidate;
  const chosen = rotatedMatch ?? targets.find(target => target.candidate.id === selection.track.id);
  if (chosen) {
    const index = targets.indexOf(chosen);
    if (index > 0) targets.unshift(...targets.splice(index, 1));
  }
  const rotatedSelection = rotatedMatch ? {
    ...selection,
    track: asVector(rotatedMatch.candidate),
    comparison: compareEmotionVectors(input.target, rotatedMatch.candidate.emotion,
      last?.maxDifference ?? 1, last?.maxDistance ?? Math.sqrt(8)),
  } : selection;
  // targets后续项仅用于加载失败恢复；最佳一定由八维selector决定。
  ranked.sort((a, b) => b.finalScore - a.finalScore);
  return { ranked, targets, best: targets[0] ?? null, selection: rotatedSelection, filteredOut };
}
