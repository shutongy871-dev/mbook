// 可运行的口径：按已观测特征分桶，SUM(action_delta) 并截断到 [-1,1]。
// 未测得的 BPM/能量不进入桶；人声可由歌词元数据保守回退。
export interface PreferenceFeatures {
  bpm?: number;
  vocalDensity?: number | null;
  energyCurve?: number[];
  hasLyrics?: boolean;
  spectralCentroidHz?: number;
}
export function preferenceKeys(c: PreferenceFeatures): string[] {
  const keys: string[] = [];
  if (c.bpm && Number.isFinite(c.bpm))
    keys.push(`bpm:${c.bpm < 80 ? 'slow' : c.bpm <= 110 ? 'medium' : 'fast'}`);
  const vocal = c.vocalDensity ?? (c.hasLyrics == null ? null : c.hasLyrics ? .65 : 0);
  if (vocal != null) keys.push(`vocal:${vocal > .4 ? 'high' : 'low'}`);
  if (c.energyCurve?.length) {
    const mean = c.energyCurve.reduce((s, v) => s + v, 0) / c.energyCurve.length;
    keys.push(`energy:${mean > .6 ? 'high' : mean < .25 ? 'low' : 'medium'}`);
  }
  if (c.spectralCentroidHz != null && Number.isFinite(c.spectralCentroidHz))
    keys.push(`timbre:${c.spectralCentroidHz < 1500 ? 'dark' : c.spectralCentroidHz > 3000 ? 'bright' : 'middle'}`);
  return keys;
}
export function featureAffinity(keys: string[], values?: Map<string, number>): number {
  return keys.length ? keys.reduce((s, key) => s + (values?.get(key) ?? 0), 0) / keys.length : 0;
}
