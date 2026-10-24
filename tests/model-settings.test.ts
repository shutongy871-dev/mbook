import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db/dexie';
import { DEFAULT_SETTINGS, settingsRepo } from '@/core/db/settings.repo';
import { normalizeModelSettings } from '@/core/llm/model-config';
import type { Settings } from '@/core/shared/contracts';

beforeEach(async () => { await db.settings.clear(); });
describe('single shared model and independent task checkboxes', () => {
  it('migrates an existing audio-only credential without enabling text inference', async () => {
    await db.settings.put({ key: 'app', value: { ...DEFAULT_SETTINGS, song_audio_enabled: true,
      song_audio_endpoint: 'https://model.test/v1', song_audio_key: 'secret', song_audio_model: 'qwen3.8-omni-flash' } });
    const next = await settingsRepo.get();
    expect(next.models).toHaveLength(1);
    expect(next.music_model_id).toBe(next.models![0]!.id);
    expect(next.text_model_id).toBeNull();
    expect(next.song_audio_key).toBe('secret');
  });
  it('deduplicates identical text and music configs; each task can select the same model', async () => {
    const s = normalizeModelSettings({ ...DEFAULT_SETTINGS, llm_endpoint: 'https://model.test/v1',
      llm_key: 'shared', llm_model: 'qwen3.8-omni-flash', song_audio_enabled: true,
      song_audio_endpoint: 'https://model.test/v1/', song_audio_key: 'shared', song_audio_model: 'qwen3.8-omni-flash' });
    expect(s.models).toHaveLength(1);
    expect(s.text_model_id).toBe(s.music_model_id);
    await settingsRepo.update(s);
    const raw = (await db.settings.get('app'))!.value as Settings;
    expect(raw.llm_key).toBe('');
    expect(raw.song_audio_key).toBe('');
    expect(raw.models?.[0]?.api_key).toBe('shared');
    const loaded = await settingsRepo.get();
    expect(loaded.llm_key).toBe('shared');
    expect(loaded.song_audio_key).toBe('shared');
  });
  it('keeps the assigned music model, rebinds enabled text to it, and preserves each checkbox state', async () => {
    const saved = await settingsRepo.update({ models: [
      { id: 'text', name: '文字', endpoint: 'https://a.test/v1', api_key: 'a', model: 'text-model' },
      { id: 'audio', name: '音乐', endpoint: 'https://b.test/v1', api_key: 'b', model: 'audio-model' },
    ], text_model_id: 'text', music_model_id: 'audio' });
    expect(saved.models).toHaveLength(1);
    expect(saved.models?.[0]?.id).toBe('audio');
    expect(saved.text_model_id).toBe('audio');
    expect(saved.llm_key).toBe('b');
    expect(saved.song_audio_key).toBe('b');
    const unassigned = await settingsRepo.update({ text_model_id: null });
    expect(unassigned.llm_key).toBe('');
    expect(unassigned.song_audio_key).toBe('b');
    expect(unassigned.models).toHaveLength(1);
    const disabled = await settingsRepo.update({ music_model_id: null });
    expect(disabled.song_audio_enabled).toBe(false);
    expect(disabled.models?.[0]?.api_key).toBe('b');
    const enabledAgain = await settingsRepo.update({ text_model_id: 'audio' });
    expect(enabledAgain.llm_key).toBe('b');
    const removed = await settingsRepo.update({ models: [] });
    expect(removed.music_model_id).toBeNull();
    expect(removed.song_audio_enabled).toBe(false);
  });
  it('retains the shared configuration when both tasks are disabled', () => {
    const s = normalizeModelSettings({ ...DEFAULT_SETTINGS, ai_strength: 'off',
      llm_endpoint: 'https://model.test/v1', llm_key: 'retained' });
    expect(s.models?.[0]?.api_key).toBe('retained');
    expect(s.llm_key).toBe('');
    expect(s.text_model_id).toBeNull();
  });
  it('collapses case-different duplicate model rows while preserving the music endpoint and model identity', async () => {
    await db.settings.put({ key: 'app', value: { ...DEFAULT_SETTINGS, models: [
      { id: 'old-text', name: '', endpoint: 'https://model.test/v1', api_key: 'old', model: 'Qwen3.8-Omni-Flash' },
      { id: 'working-audio', name: '', endpoint: 'https://model.test/v1', api_key: 'working', model: 'qwen3.8-omni-flash' },
    ], text_model_id: 'old-text', music_model_id: 'working-audio' } });
    const migrated = await settingsRepo.get();
    expect(migrated.models).toHaveLength(1);
    expect(migrated).toMatchObject({ text_model_id: 'working-audio', music_model_id: 'working-audio',
      llm_model: 'qwen3.8-omni-flash', llm_key: 'working', song_audio_model: 'qwen3.8-omni-flash',
      song_audio_endpoint: 'https://model.test/v1' });
    await settingsRepo.update({ models: migrated.models, text_model_id: migrated.text_model_id, music_model_id: migrated.music_model_id });
    expect(((await db.settings.get('app'))?.value as Settings).models).toHaveLength(1);
  });
});
