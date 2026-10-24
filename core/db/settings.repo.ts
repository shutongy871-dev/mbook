import { db } from './dexie';
import type { Settings } from '@/core/shared/contracts';
import { normalizeModelSettings, storedModelSettings } from '@/core/llm/model-config';

const SETTINGS_KEY = 'app';

// 默认值与 PRD 设置项表对齐
export const DEFAULT_SETTINGS: Settings = {
  update_interval_sec: 6,
  window_size: 300,
  fade_out_ms: 1500,
  fade_in_ms: 1500,
  ai_strength: 'standard',
  llm_endpoint: '',
  llm_key: '',
  lyric_policy: 'instrumental_preferred',
  bpm_ranges: { calm: [60, 100], peak: [80, 120] },
  style_blacklist: [],
  source_weight: 'balanced',
  enabled_sources: ['netease', 'builtin'],
  base_volume: 40,
  autoplay: true,
  auto_pause: true,
  plugin_enabled: true,
  netease_enabled: true,
  llm_model: '',
  song_audio_enabled: false,
  song_audio_endpoint: '',
  song_audio_key: '',
  song_audio_model: 'qwen3.8-omni-flash',
  song_audio_limit: 50,
  embedding_model: '',
  netease_search_supplement: false,
  floating_ball: true,
  vocal_penalty: 0,
};

export function normalizeSettings(input: Settings): Settings {
  const next = { ...input };
  // 已删除的切歌门槛不再从旧设置恢复或写回。
  for (const key of ['stable_windows_k', 'delta_e_threshold', 'min_switch_interval_sec', 'switch_threshold']) {
    delete (next as unknown as Record<string, unknown>)[key];
  }
  const ranges = {
    update_interval_sec: [3, 15],
    window_size: [150, 600], fade_out_ms: [500, 3000],
    fade_in_ms: [500, 3000], base_volume: [0, 100], vocal_penalty: [0, .5],
    song_audio_limit: [1, 5000],
  } as const;
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    const value = Number(input[key]);
    next[key] = Number.isFinite(value) ? Math.max(ranges[key][0], Math.min(ranges[key][1], value)) : DEFAULT_SETTINGS[key];
    if (key !== 'vocal_penalty') next[key] = Math.round(next[key]);
  }
  next.bpm_ranges = { ...input.bpm_ranges };
  next.style_blacklist = input.style_blacklist.map(style => style.trim()).filter(Boolean);
  for (const kind of ['calm', 'peak'] as const) {
    const [a, b] = input.bpm_ranges?.[kind] ?? DEFAULT_SETTINGS.bpm_ranges[kind];
    const low = Number.isFinite(a) ? Math.max(30, Math.min(240, a)) : DEFAULT_SETTINGS.bpm_ranges[kind][0];
    const high = Number.isFinite(b) ? Math.max(30, Math.min(240, b)) : DEFAULT_SETTINGS.bpm_ranges[kind][1];
    next.bpm_ranges[kind] = [Math.min(low, high), Math.max(low, high)];
  }
  return normalizeModelSettings(next);
}

export const settingsRepo = {
  async get(): Promise<Settings> {
    const row = await db.settings.get(SETTINGS_KEY);
    return normalizeSettings(row
      ? { ...DEFAULT_SETTINGS, ...(row.value as Partial<Settings>) }
      : { ...DEFAULT_SETTINGS });
  },

  async update(patch: Partial<Settings>): Promise<Settings> {
    const merged = { ...(await this.get()), ...patch };
    // 兼容旧设置页/调用者；新版页面始终提交模型列表和任务ID。
    if (!('models' in patch) && ['llm_endpoint', 'llm_key', 'llm_model', 'song_audio_endpoint',
      'song_audio_key', 'song_audio_model', 'song_audio_enabled', 'ai_strength'].some(key => key in patch))
      delete merged.models;
    const next = normalizeSettings(merged);
    await db.settings.put({ key: SETTINGS_KEY, value: storedModelSettings(next) });
    return next;
  },
};
