import { db } from './dexie';
import { settingsRepo } from './settings.repo';
import { audioIdentity, validateAudioConfig } from '@/core/llm/qwen-audio';
import type { AudioTagBudget, AudioTagJob, Settings } from '@/core/shared/contracts';

const BUDGET_KEY = 'song-audio-budget';
const LEASE_MS = 5 * 60_000;
export async function audioBudget(): Promise<AudioTagBudget> {
  return (await db.settings.get(BUDGET_KEY))?.value as AudioTagBudget ?? { attempts: 0 };
}

export async function enqueueAudioJobs(songId?: string): Promise<{ queued: number; cached: boolean }> {
  const settings = await settingsRepo.get();
  validateAudioConfig(settings);
  if (!settings.song_audio_enabled || !settings.plugin_enabled) throw new Error('请先开启并保存音乐听感识别与插件总开关');
  const identity = audioIdentity(settings);
  return db.transaction('rw', db.songs, db.songProfiles, db.audioJobs, db.settings, async () => {
    const budget = await audioBudget();
    await db.audioJobs.where('status').equals('queued').modify(job => {
      if (job.identity !== identity) {
        job.status = 'failed'; job.updated_at = 0;
        job.error = '音频配置已变化，旧队列未发送请求';
      }
    });
    const existingJobs = await db.audioJobs.toArray();
    let space = settings.song_audio_limit - budget.attempts - existingJobs.filter(j => j.status === 'queued').length;
    const songs = songId ? [await db.songs.get(songId)].filter(s => !!s) :
      await db.songs.filter(s => !s.blacklisted && s.copyright_available &&
        s.duration_sec >= 60 && s.duration_sec <= 600).toArray();
    if (songId && !songs.length) throw new Error('未找到这首入库歌曲，请先同步网易云曲库');
    let queued = 0, cached = false;
    for (const song of songs) {
      if (song.blacklisted || !song.copyright_available) continue;
      const old = existingJobs.find(j => j.song_id === song.song_id);
      const profile = (await db.songProfiles.get(song.song_id))?.audio_emotion;
      if (profile?.identity === identity && profile.emotion !== null) { cached = Boolean(songId); continue; }
      if (old?.status === 'queued' || old?.status === 'processing') continue;
      if (!songId && old?.identity === identity) continue; // 失败/未知只由用户逐首重试
      if (songId && old && Date.now() - old.updated_at < 60_000)
        throw new Error('距上次尝试不足 60 秒，请稍后重试');
      if (space <= 0) break;
      await db.audioJobs.put({ song_id: song.song_id, identity, status: 'queued',
        attempts: old?.attempts ?? 0, updated_at: Date.now() });
      space--; queued++;
    }
    if (!queued && !cached && space <= 0 &&
      (budget.attempts >= settings.song_audio_limit || !existingJobs.some(j => j.status === 'queued')))
      throw new Error('已达到累计尝试上限，请提高上限并保存后继续');
    await db.settings.put({ key: BUDGET_KEY, value: { attempts: budget.attempts } });
    return { queued, cached };
  });
}

export async function claimAudioJob(settings: Settings, now = Date.now()): Promise<AudioTagJob | null> {
  return db.transaction('rw', db.settings, db.audioJobs, db.songs, async () => {
    // 丢失的请求可能已经计费，绝不自动重发。
    await db.audioJobs.where('status').equals('processing').modify(job => {
      if ((job.lease_until ?? 0) <= now) {
        job.status = 'failed'; job.updated_at = now;
        job.error = '任务中断，服务可能已计费；未自动重试，可在检查后逐首重试';
        delete job.lease_until;
      }
    });
    if (await db.audioJobs.where('status').equals('processing').count()) return null;
    const budget = await audioBudget();
    if (!settings.song_audio_enabled || !settings.plugin_enabled || budget.halted ||
      budget.attempts >= settings.song_audio_limit) return null;
    const identity = audioIdentity(settings);
    const queued = await db.audioJobs.where('status').equals('queued').sortBy('updated_at');
    for (const job of queued) {
      const song = await db.songs.get(job.song_id);
      if (!song || song.blacklisted || !song.copyright_available || identity !== job.identity) {
        await db.audioJobs.update(job.song_id, { status: 'failed', updated_at: now,
          error: '歌曲已移除/不可用或音频配置已变化，请按新配置重新提交' });
        continue;
      }
      const next: AudioTagJob = { ...job, status: 'processing', attempts: job.attempts + 1,
        updated_at: now, lease_until: now + LEASE_MS, request_id: crypto.randomUUID(), error: undefined };
      await db.audioJobs.put(next);
      await db.settings.put({ key: BUDGET_KEY, value: { ...budget, attempts: budget.attempts + 1 } });
      return next;
    }
    return null;
  });
}

export async function failAudioJob(job: AudioTagJob, error: string, halt = false): Promise<void> {
  await db.transaction('rw', db.audioJobs, db.settings, async () => {
    const current = await db.audioJobs.get(job.song_id);
    if (!current || current.request_id !== job.request_id || current.status !== 'processing') return;
    await db.audioJobs.update(job.song_id, { status: 'failed', updated_at: Date.now(), error, lease_until: undefined });
    if (halt) await db.settings.put({ key: BUDGET_KEY, value: { ...await audioBudget(), halted: error } });
  });
}
