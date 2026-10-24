import type { ModelConfig, Settings } from '@/core/shared/contracts';

function endpointKey(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

// 单一共享模型；沿用旧字段作为任务启用标记与运行时投影，models最多一项。
// 旧版多模型迁移优先保留已分配给音乐的配置，维持音频画像缓存身份。
export function normalizeModelSettings(input: Settings): Settings {
  const next = { ...input };
  if (!Array.isArray(input.models)) {
    const models: ModelConfig[] = [];
    const add = (endpoint: string, api_key: string, model: string) => {
      if (!endpoint.trim() && !api_key.trim()) return null;
      const existing = models.find(m => endpointKey(m.endpoint) === endpointKey(endpoint) &&
        m.api_key === api_key.trim() && m.model === model.trim());
      if (existing) return existing.id;
      const id = `migrated-${models.length + 1}`;
      models.push({ id, name: model.trim(), endpoint: endpoint.trim(), api_key: api_key.trim(), model: model.trim() });
      return id;
    };
    const text = add(input.llm_endpoint, input.llm_key, input.llm_model || 'gpt-4o-mini');
    const music = add(input.song_audio_endpoint, input.song_audio_key, input.song_audio_model || 'qwen3.8-omni-flash');
    next.models = models;
    next.text_model_id = input.ai_strength === 'off' ? null : text;
    next.music_model_id = input.song_audio_enabled ? music : null;
  } else {
    const ids = new Set<string>();
    next.models = input.models.filter(model => model && typeof model.id === 'string' && model.id && !ids.has(model.id) && ids.add(model.id))
      .map(model => ({ id: model.id, name: String(model.name ?? '').trim(),
        endpoint: String(model.endpoint ?? '').trim(), api_key: String(model.api_key ?? '').trim(),
        model: String(model.model ?? '').trim() }));
  }
  const previousText = next.models.find(m => m.id === next.text_model_id);
  const previousMusic = next.models.find(m => m.id === next.music_model_id);
  const shared = previousMusic ?? previousText ??
    next.models.find(m => m.endpoint && m.api_key && m.model) ?? next.models[0];
  next.models = shared ? [shared] : [];
  const text = previousText ? shared : undefined;
  const music = previousMusic ? shared : undefined;
  next.text_model_id = text?.id ?? null;
  next.music_model_id = music?.id ?? null;
  next.llm_endpoint = text?.endpoint ?? '';
  next.llm_key = text?.api_key ?? '';
  next.llm_model = text?.model ?? '';
  next.ai_strength = text ? 'standard' : 'off';
  next.song_audio_endpoint = music?.endpoint ?? '';
  next.song_audio_key = music?.api_key ?? '';
  next.song_audio_model = music?.model ?? 'qwen3.8-omni-flash';
  next.song_audio_enabled = Boolean(music);
  return next;
}

export function storedModelSettings(settings: Settings): Settings {
  return { ...settings, llm_endpoint: '', llm_key: '', llm_model: '',
    song_audio_endpoint: '', song_audio_key: '', song_audio_model: '' };
}

export function modelConfigError(model: ModelConfig): string | null {
  if (!model.model.trim()) return '请填写模型名';
  if (!model.api_key.trim()) return '请填写 API Key';
  if (model.api_key.includes('****')) return '请填写完整 API Key，不能使用脱敏值';
  try {
    const url = new URL(model.endpoint.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { return '请填写有效的 HTTPS 接口地址'; }
  return null;
}
