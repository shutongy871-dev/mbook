import { browser } from 'wxt/browser';
import { db } from '@/core/db/dexie';
import { settingsRepo } from '@/core/db/settings.repo';
import { claimAudioJob, failAudioJob } from '@/core/db/audio-jobs.repo';
import { recognizeAudio, AudioTagError, audioIdentity } from '@/core/llm/qwen-audio';
import { prepareAudioSample } from './audio-sample';
import { TAG_VERSION } from './song-tagger';
import type { AudioEmotionProfile, AudioTagJob } from '@/core/shared/contracts';

let active: AbortController | null = null;

export function cancelAudioWork(): void { active?.abort(); }

export async function commitAudioProfile(job: AudioTagJob, result: AudioEmotionProfile): Promise<void> {
  await db.transaction('rw', db.songs, db.songProfiles, db.audioJobs, async () => {
    const current = await db.audioJobs.get(job.song_id);
    if (!current || current.request_id !== job.request_id || current.status !== 'processing') return;
    const song = await db.songs.get(job.song_id);
    if (!song) throw new AudioTagError('歌曲已从曲库移除');
    // 未知结果仍可核查证据；已有有效画像不被失败/未知覆盖。
    if (result.emotion !== null) {
      const profile = await db.songProfiles.get(job.song_id) ?? {
        song_id: job.song_id, emotion_vector: null, music_tags: [], semantic_text: '',
        semantic_embedding: [], audio_features: null, popularity_raw: 0, popularity_score: 40, platform_tags: [],
      };
      await db.songProfiles.put({ ...profile, audio_emotion: result, emotion_vector: result.emotion,
        semantic_text: result.segments.map(s => s.evidence).join('；').slice(0, 500),
        semantic_embedding: [], embedding_model: undefined });
      await db.songs.update(job.song_id, { tag_version: TAG_VERSION, profile_status: 'llm_done' });
    }
    await db.audioJobs.update(job.song_id, { status: result.emotion === null ? 'unknown' : 'complete',
      result, updated_at: Date.now(), lease_until: undefined,
      error: result.emotion === null ? '采样片段均无法判断情绪，已保留原画像' : undefined });
  });
}

// 在Offscreen独立执行；开始消息立即确认，不占用播放调度队列。
export async function runAudioWork(): Promise<void> {
  if (active) return;
  const control = new AbortController();
  active = control;
  try {
    while (!control.signal.aborted) {
      const settings = await settingsRepo.get();
      if (!settings.song_audio_enabled || !settings.song_audio_key.trim()) break;
      const job = await claimAudioJob(settings);
      if (!job) break;
      const timeout = AbortSignal.timeout(180_000);
      const signal = AbortSignal.any([control.signal, timeout]);
      // 周期消息只维持任务联络，重启后的互斥以IndexedDB租约为准。
      const ping = setInterval(() => { void browser.runtime.sendMessage({ type: 'OFFSCREEN_AUDIO_PROGRESS' }).catch(() => {}); }, 20_000);
      try {
        // Offscreen 只允许 runtime 扩展API；平台Cookie/地址解析由SW处理。
        const resolved = await browser.runtime.sendMessage({
          type: 'AUDIO_TAG_RESOLVE', songId: job.song_id, requestId: job.request_id,
        }) as { url?: string } | null;
        signal.throwIfAborted();
        if (!resolved?.url) throw new AudioTagError('未获得可用音频地址，请检查登录、版权或试听限制');
        const song = await db.songs.get(job.song_id);
        const sample = await prepareAudioSample(resolved.url, signal, song?.duration_sec);
        const result = await recognizeAudio(settings, sample, signal);
        signal.throwIfAborted();
        const currentSettings = await settingsRepo.get();
        if (!currentSettings.song_audio_enabled || !currentSettings.plugin_enabled ||
          audioIdentity(currentSettings) !== job.identity ||
          currentSettings.song_audio_key !== settings.song_audio_key)
          throw new AudioTagError('音频配置已改变，本次结果未应用；请按当前配置重试');
        await commitAudioProfile(job, result);
      } catch (error) {
        const message = signal.aborted
          ? control.signal.aborted ? '任务已停止，可能已经产生 API 费用；未自动重试' : '音频识别超时，可能已计费；未自动重试'
          : error instanceof AudioTagError ? error.message
            : error instanceof Error && error.message.startsWith('音频') || error instanceof Error && error.message.startsWith('下载音频')
              ? error.message : '音频下载、解码或网络请求失败；请检查地址与网络后手动重试';
        await failAudioJob(job, message, error instanceof AudioTagError && error.halt);
      } finally {
        clearInterval(ping);
        void browser.runtime.sendMessage({ type: 'OFFSCREEN_AUDIO_PROGRESS' }).catch(() => {});
      }
    }
  } finally { active = null; }
}
