import type { CandidateTrack } from './candidate-pool';
import type { Settings } from '@/core/shared/contracts';
import { qualityScore } from './ranking-metrics';

// Reasons are returned to the caller for inspection; high ranking scores cannot override them.
export function filterReason(c: CandidateTrack, settings: Settings): string | null {
  return filterReasons(c, settings)[0] ?? null;
}

// 诊断返回全部原因；选歌仍使用同顺序的首个原因。
export function filterReasons(c: CandidateTrack, settings: Settings): string[] {
  const reasons: string[] = [];
  if (c.playable === false) reasons.push('unplayable');
  if (c.copyrightAvailable === false) reasons.push('copyright');
  if (c.durationSec < 60 || c.durationSec > 600) reasons.push('duration');
  if (qualityScore(c) < 70) reasons.push('quality');
  const maxVocal = { instrumental_only: .2, instrumental_preferred: .4, any: .8 }[settings.lyric_policy];
  if (settings.lyric_policy === 'instrumental_only' && c.hasLyrics) reasons.push('lyrics');
  if ((c.vocalDensity ?? (c.hasLyrics ? .65 : 0)) > maxVocal) reasons.push('vocal_density');
  const styles = settings.style_blacklist.map(s => s.trim().toLowerCase()).filter(Boolean);
  if (c.tags.some(tag => styles.some(style => tag.toLowerCase().includes(style)))) reasons.push('style');
  return reasons;
}
