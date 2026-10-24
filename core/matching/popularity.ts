import { db } from '@/core/db/dexie';
import type { PlatformPopularity } from '@/core/shared/contracts';

export function validPlatformMetrics(value: PlatformPopularity | undefined, now: number): value is PlatformPopularity {
  return Boolean(value?.provider?.trim() && Number.isFinite(value.window_end) &&
    value.window_end <= now && now - value.window_end <= 7 * 86400000 &&
    [value.plays7d, value.exposures7d, value.playlistGrowth7d].every(Number.isSafeInteger) &&
    value.plays7d >= 0 && value.exposures7d >= 0);
}

export interface PopularitySignals {
  id: string;
  cohort?: string; // 相同来源及统计窗口；不同平台的原生 pop 不具备共同尺度
  plays7d?: number;
  exposures7d?: number;
  playlistGrowth7d?: number;
  platformProxy?: number;
}

// SQL 等价：z=(x-AVG(x) OVER())/STDDEV_POP(x) OVER()；常数列贡献 0。
// 三项平台指标缺失时不能填造计数；只有原生 pop 时单独标记代理口径。
export function computePopularity(rows: PopularitySignals[]): Array<{
  id: string; raw: number; score: number; basis: 'platform_metrics' | 'platform_proxy' | 'neutral';
}> {
  const cohorts = new Set(rows.map(row => row.cohort ?? 'default'));
  if (cohorts.size > 1) {
    const scores = new Map([...cohorts].flatMap(cohort =>
      computePopularity(rows.filter(row => (row.cohort ?? 'default') === cohort))).map(row => [row.id, row]));
    return rows.map(row => scores.get(row.id)!);
  }
  const keys = ['plays7d', 'exposures7d', 'playlistGrowth7d', 'platformProxy'] as const;
  const stats = Object.fromEntries(keys.map(key => {
    const values = rows.map(r => r[key]).filter((v): v is number => v != null && Number.isFinite(v));
    const mean = values.reduce((s, v) => s + v, 0) / (values.length || 1);
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length || 1));
    return [key, { mean, sd }];
  }));
  const z = (key: typeof keys[number], value: number) => stats[key]!.sd ? (value - stats[key]!.mean) / stats[key]!.sd : 0;
  return rows.map(row => {
    const available = ([['plays7d', .5], ['exposures7d', .3], ['playlistGrowth7d', .2]] as const)
      .filter(([key]) => row[key] != null && Number.isFinite(row[key]));
    const weight = available.reduce((sum, [, w]) => sum + w, 0);
    const proxy = row.platformProxy != null && Number.isFinite(row.platformProxy);
    const raw = weight ? available.reduce((sum, [key, w]) => sum + w * z(key, row[key]!), 0) / weight :
      proxy ? z('platformProxy', row.platformProxy!) : 0;
    return { id: row.id, raw, score: weight || proxy ? 100 / (1 + Math.exp(-raw)) : 40,
      basis: weight ? 'platform_metrics' as const : proxy ? 'platform_proxy' as const : 'neutral' as const };
  });
}

export async function refreshPopularity(now = Date.now()): Promise<void> {
  const profiles = await db.songProfiles.toArray();
  if (!profiles.length || profiles.every(p => now - (p.popularity_updated_at ?? 0) < 86400000)) return;
  const songs = await db.songs.toArray();
  const scores = computePopularity(songs.map(s => ({
    id: s.song_id, platformProxy: s.popularity_raw && s.popularity_raw > 0 ? s.popularity_raw : undefined,
    cohort: validPlatformMetrics(s.popularity_metrics, now) ?
      `metrics:${s.popularity_metrics.provider}:${Math.floor(s.popularity_metrics.window_end / 86400000)}` :
      `proxy:${s.primary_source ?? s.song_id.split(':')[0]}`,
    ...(validPlatformMetrics(s.popularity_metrics, now) ? {
      plays7d: s.popularity_metrics.plays7d,
      exposures7d: s.popularity_metrics.exposures7d,
      playlistGrowth7d: s.popularity_metrics.playlistGrowth7d,
    } : {}),
  })));
  await db.transaction('rw', db.songProfiles, async () => {
    for (const value of scores) await db.songProfiles.update(value.id, {
      popularity_raw: value.raw, popularity_score: value.score,
      popularity_basis: value.basis, popularity_updated_at: now,
    });
  });
}
