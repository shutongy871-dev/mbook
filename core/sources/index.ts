// 曲库同步与播放地址解析（方案 Step 4：每小时同步 + 容灾回退）
import { songsRepo } from '@/core/db/songs.repo';
import { logger } from '@/core/shared/logger';
import { neteaseAdapter } from './netease';
import type { SourceTrack } from './types';
import { browser } from 'wxt/browser';
import { db } from '@/core/db/dexie';
import type { StatusResponse } from '@/core/shared/contracts';
import { inspectLyrics } from './netease';

// 同步关键词：按八类情绪氛围搜纯音乐，保证各情绪档都有真实歌曲可选
const SYNC_QUERIES = [
  '安静 钢琴 纯音乐',
  '治愈 轻音乐 放松',
  '忧伤 钢琴 纯音乐',
  '悬疑 紧张 配乐',
  '史诗 燃 背景音乐',
  '专注 学习 轻音乐',
  '夜晚 放松 纯音乐',
  '温暖 吉他 纯音乐',
  '神秘 氛围音乐',
  '希望 励志 背景音乐',
];

const PER_QUERY = 10;
let syncing = false;

export function isSyncing(): boolean {
  return syncing;
}

// 拉取网易云元数据入库（搜索只拿元数据；播放地址按需解析）
export async function getSourceStatus(): Promise<StatusResponse['source_status']> {
  const status = (await browser.storage.local.get('sourceStatus')).sourceStatus as StatusResponse['source_status'] ?? { state: 'unknown' };
  const songs = await db.songs.filter(song => song.primary_source === 'netease').toArray();
  return { ...status, library_count: songs.length,
    playable_count: songs.filter(song => song.playable && song.copyright_available && !song.blacklisted).length };
}

export async function syncMusicLibrary(supplement = false): Promise<{ added: number; total: number }> {
  if (syncing) return { added: 0, total: await songsRepo.count() };
  syncing = true;
  try {
    const library = await neteaseAdapter.fetchLibrary();
    const all: SourceTrack[] = [...library.tracks];
    if (supplement) for (const q of SYNC_QUERIES) all.push(...await neteaseAdapter.search(q, PER_QUERY));
    const sourceStatus = {
      state: library.state, name: library.name, last_sync: Date.now(),
      message: library.state === 'signed_out' ? '请在网易云网页版登录后同步' : `已读取 ${library.tracks.length} 条歌单曲目`,
    };
    if (all.length === 0) {
      await browser.storage.local.set({ sourceStatus });
      logger.warn('[sources] 网易云无结果或网络不可用，继续使用 CC0 兜底');
      return { added: 0, total: await songsRepo.count() };
    }
    const songs = all.map((t) =>
      songsRepo.makeSong({
        source: t.source,
        sourceSongId: t.sourceSongId,
        title: t.title,
        artist: t.artist,
        album: t.album,
        durationSec: t.durationSec,
        hasLyrics: t.hasLyrics,
        popularityRaw: t.popularityRaw,
        popularityMetrics: t.popularityMetrics,
        bitrateKbps: t.bitrateKbps, language: t.language,
        streamUrl: t.streamUrl, urlExpireAt: t.urlExpireAt, playable: t.playable,
        copyrightAvailable: t.copyrightAvailable, channels: t.channels,
        platformTags: t.platformTags, playlistTags: t.playlistTags,
      }),
    );
    const result = await songsRepo.upsertMany(songs);
    // Report successful synchronization only after the database has committed.
    await browser.storage.local.set({ sourceStatus });
    logger.info(`[sources] 曲库同步完成：新增 ${result.added}，总 ${result.total}`);
    return result;
  } catch (e) {
    await browser.storage.local.set({ sourceStatus: { state: 'error', message: '同步失败，保留已有曲库；可稍后重试' } });
    logger.warn('[sources] 曲库同步失败（CC0 兜底不受影响）:', e);
    return { added: 0, total: await songsRepo.count() };
  } finally {
    syncing = false;
  }
}

const resolveCache = new Map<string, { url: string; expireAt: number }>();

export async function invalidatePlayableUrl(songId: string): Promise<void> {
  resolveCache.delete(songId);
  await db.songs.update(songId, { url_expire_at: 0 });
}

export async function resolveBackupUrls(songId: string, signal?: AbortSignal, limit = Infinity): Promise<string[]> {
  signal?.throwIfAborted();
  const song = await songsRepo.get(songId);
  if (!song) return [];
  const backups = song.backup_sources.map(backup => ({ ...backup }));
  const urls: string[] = [];
  for (const backup of backups) {
    if (urls.length >= limit) break;
    signal?.throwIfAborted();
    if (backup.url && (backup.expireAt ?? 0) > Date.now() + 60_000) {
      urls.push(backup.url);
      continue;
    }
    if (backup.source !== 'netease' || !backup.sourceSongId) continue;
    try {
      const fresh = await neteaseAdapter.resolveUrl({
        source: 'netease', sourceSongId: backup.sourceSongId, title: song.title,
        artist: song.artist, album: song.album, durationSec: song.duration_sec,
        hasLyrics: song.has_lyrics, bitrateKbps: 0, popularityRaw: 0, streamUrl: '',
        urlExpireAt: 0, playable: true,
      }, signal);
      signal?.throwIfAborted();
      if (fresh?.streamUrl) {
        backup.url = fresh.streamUrl;
        backup.expireAt = fresh.urlExpireAt;
        urls.push(fresh.streamUrl);
      }
    } catch (e) {
      signal?.throwIfAborted();
      logger.warn('[backup URL]', e);
    }
  }
  signal?.throwIfAborted();
  await db.songs.update(songId, { backup_sources: backups });
  return [...new Set(urls)];
}

// 播放前解析地址：内存缓存 30 分钟；失败返回 null，调用方换候选或回退 CC0
export async function resolvePlayableUrl(
  songId: string,
  signal?: AbortSignal,
): Promise<{ url: string; bitrate: number } | null> {
  signal?.throwIfAborted();
  const cached = resolveCache.get(songId);
  if (cached && cached.expireAt > Date.now() + 60_000) {
    return { url: cached.url, bitrate: 0 };
  }
  const song = await songsRepo.get(songId);
  if (!song) return null;
  if (song.stream_url && song.url_expire_at > Date.now() + 60_000) return { url: song.stream_url, bitrate: song.bitrate_kbps };
  const track: SourceTrack = {
    source: song.primary_source ?? 'netease',
    sourceSongId: song.source_song_id ?? songId.split(':')[1] ?? songId,
    title: song.title,
    artist: song.artist,
    album: song.album,
    durationSec: song.duration_sec,
    hasLyrics: song.has_lyrics,
    bitrateKbps: song.bitrate_kbps,
    popularityRaw: 0,
    streamUrl: song.stream_url,
    urlExpireAt: song.url_expire_at,
    playable: song.playable,
  };
  const resolved = await neteaseAdapter.resolveUrl(track, signal);
  signal?.throwIfAborted();
  if (!resolved?.streamUrl) return null;
  await db.songs.update(songId, { stream_url: resolved.streamUrl, url_expire_at: resolved.urlExpireAt,
    bitrate_kbps: resolved.bitrateKbps, playable: true, copyright_available: true });
  resolveCache.set(songId, {
    url: resolved.streamUrl,
    expireAt: resolved.urlExpireAt,
  });
  return { url: resolved.streamUrl, bitrate: resolved.bitrateKbps };
}

// Probe a bounded batch before it enters the selectable library. Playback still verifies each attempt.
export async function probeSong(songId: string): Promise<boolean> {
  const song = await songsRepo.get(songId);
  if (!song) return false;
  const result = await resolvePlayableUrl(songId);
  const lyrics = await inspectLyrics(song.source_song_id ?? songId.split(':')[1] ?? songId);
  await db.songs.update(songId, {
    playable: Boolean(result),
    last_probe_at: Date.now(),
    ...(lyrics ? { has_lyrics: lyrics.hasLyrics, language: lyrics.language } : {}),
  });
  return Boolean(result);
}
