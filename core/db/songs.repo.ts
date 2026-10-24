// 曲库仓库：外部音源歌曲（网易云等）归一化后入库；CC0 内置曲不入库
import { db } from './dexie';
import type { Song } from '@/core/shared/contracts';

export function dedupKey(title: string, artist: string, duration: number): string {
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  return `${norm(title)}|${norm(artist)}|${Math.round(duration / 3)}`;
}

export const songsRepo = {
  async upsertMany(songs: Song[]): Promise<{ added: number; total: number }> {
    return db.transaction('rw', db.songs, async () => {
      let added = 0;
      for (const incoming of songs) {
        const key = dedupKey(incoming.title, incoming.artist, incoming.duration_sec);
        const old = await db.songs.get(incoming.song_id) ??
          await db.songs.where('dedup_key').equals(key).first();
        if (!old) {
          await db.songs.put({ ...incoming, dedup_key: key });
          added++;
          continue;
        }
        // Keep the existing entity id and feedback references across source merges.
        const priority = (s: Song) => ['soda', 'douyin', 'netease', 'qq'].indexOf(s.primary_source ?? s.song_id.split(':')[0] ?? '');
        const replace = priority(incoming) >= 0 && (priority(old) < 0 || priority(incoming) < priority(old));
        const same = (incoming.source_song_id ?? incoming.song_id.split(':')[1]) === (old.source_song_id ?? old.song_id.split(':')[1]) &&
          (incoming.primary_source ?? incoming.song_id.split(':')[0]) === (old.primary_source ?? old.song_id.split(':')[0]);
        const primary = replace || same ? incoming : old;
        const secondary = replace || same ? old : incoming;
        const backups = [...old.backup_sources, ...incoming.backup_sources];
        if (!same && primary.song_id !== secondary.song_id) backups.push({
          source: secondary.primary_source ?? secondary.song_id.split(':')[0] ?? '',
          sourceSongId: secondary.source_song_id ?? secondary.song_id.split(':')[1],
          url: secondary.stream_url, expireAt: secondary.url_expire_at,
        });
        await db.songs.put({
          ...old, ...primary, song_id: old.song_id, dedup_key: key,
          title: primary.title || secondary.title, artist: primary.artist || secondary.artist,
          album: primary.album || secondary.album,
          bitrate_kbps: same && !incoming.bitrate_kbps ? old.bitrate_kbps : primary.bitrate_kbps,
          has_lyrics: same && old.last_probe_at && !incoming.stream_url ? old.has_lyrics : primary.has_lyrics,
          language: same && old.last_probe_at && !incoming.stream_url ? old.language : primary.language,
          source_channels: [...new Set([...old.source_channels, ...incoming.source_channels])],
          platform_tags: [...new Set([...old.platform_tags ?? [], ...incoming.platform_tags ?? []])],
          playlist_tags: [...new Set([...old.playlist_tags ?? [], ...incoming.playlist_tags ?? []])],
          backup_sources: backups.filter((v, i, a) => a.findIndex(x => x.source === v.source && x.sourceSongId === v.sourceSongId && x.url === v.url) === i),
          stream_url: same && !incoming.stream_url ? old.stream_url : primary.stream_url,
          url_expire_at: same && !incoming.stream_url ? old.url_expire_at : primary.url_expire_at,
          first_seen_at: old.first_seen_at, added_at: Math.min(old.added_at, incoming.added_at),
          last_matched_at: old.last_matched_at, blacklisted: old.blacklisted,
          tag_version: old.tag_version, profile_status: old.profile_status,
          playable: same && !incoming.stream_url ? old.playable : primary.playable,
        });
      }
      return { added, total: await db.songs.count() };
    });
  },

  async count(): Promise<number> {
    return db.songs.count();
  },

  // 可参与匹配的歌曲：未拉黑
  async listSelectable(): Promise<Song[]> {
    return db.songs.filter((s) => !s.blacklisted).toArray();
  },

  async listPendingTag(limit: number, hasKey = false, version = 'emotion-8-v1', preferred: string[] = []): Promise<Song[]> {
    const all = await db.songs.filter(s => !s.blacklisted &&
      (s.tag_version !== version || s.profile_status === 'pending' ||
        (hasKey && s.profile_status !== 'llm_done')) &&
      (!s.last_tag_attempt || Date.now() - s.last_tag_attempt >= 3600_000)).toArray();
    return all.sort((a, b) => Number(preferred.includes(b.song_id)) - Number(preferred.includes(a.song_id)) ||
      b.last_matched_at - a.last_matched_at || a.first_seen_at - b.first_seen_at).slice(0, Math.min(20, limit));
  },

  async get(songId: string): Promise<Song | undefined> {
    return db.songs.get(songId);
  },

  async markPlayed(songId: string, url: string, now: number): Promise<void> {
    await this.recordLoad(songId, true);
    await db.songs.update(songId, { playable: true, stream_url: url, last_matched_at: now });
  },

  async markLoadFailure(songId: string): Promise<void> {
    await this.recordLoad(songId, false);
    await db.songs.update(songId, { playable: false });
  },

  async recordLoad(songId: string, ok: boolean): Promise<void> {
    const song = await db.songs.get(songId);
    if (song) await db.songs.update(songId, { load_attempts: [
      ...(song.load_attempts ?? []).filter(a => Date.now() - a.ts < 7 * 86400_000),
      { ts: Date.now(), ok },
    ].slice(-200) });
  },

  async prune(now = Date.now()): Promise<number> {
    return db.transaction('rw', db.songs, db.songProfiles, db.userEvents, db.sceneStats, async () => {
      const stale = await db.songs.filter(s => !s.blacklisted &&
        now - (s.last_matched_at || s.first_seen_at) > 30 * 86400_000).primaryKeys();
      await db.songs.bulkDelete(stale);
      await db.songProfiles.bulkDelete(stale);
      await db.sceneStats.filter(s => stale.includes(s.song_id)).delete();
      await db.userEvents.where('ts').below(now - 90 * 86400_000).delete();
      return stale.length;
    });
  },
  async updateProfileStatus(songId: string, status: Song['profile_status']): Promise<void> {
    await db.songs.update(songId, { profile_status: status });
  },

  async setBlacklisted(songId: string, blacklisted: boolean): Promise<void> {
    await db.songs.update(songId, { blacklisted });
  },

  // 淘汰：连续不可播 / 链接长期过期的歌（Step 4 容灾）
  async evictUnplayable(): Promise<number> {
    const all = await db.songs.toArray();
    const dead = all.filter((s) => !s.playable && !s.copyright_available);
    if (dead.length > 0) await db.songs.bulkDelete(dead.map((s) => s.song_id));
    return dead.length;
  },

  makeSong(input: {
    source: string;
    sourceSongId: string;
    title: string;
    artist: string;
    album?: string;
    durationSec: number;
    hasLyrics: boolean;
    language?: string;
    bitrateKbps?: number;
    popularityRaw?: number;
    popularityMetrics?: Song['popularity_metrics'];
    streamUrl?: string;
    urlExpireAt?: number;
    playable?: boolean;
    copyrightAvailable?: boolean;
    channels?: string[];
    platformTags?: string[];
    playlistTags?: string[];
  }): Song {
    const now = Date.now();
    return {
      song_id: `${input.source}:${input.sourceSongId}`,
      dedup_key: dedupKey(input.title, input.artist, input.durationSec),
      source_channels: input.channels ?? [input.source],
      source_song_id: input.sourceSongId,
      primary_source: input.source,
      platform_tags: input.platformTags ?? [],
      playlist_tags: input.playlistTags ?? [],
      popularity_raw: input.popularityRaw ?? 0,
      popularity_metrics: input.popularityMetrics,
      title: input.title,
      artist: input.artist,
      album: input.album ?? '',
      duration_sec: input.durationSec,
      has_lyrics: input.hasLyrics,
      language: input.language ?? 'zh',
      bitrate_kbps: input.bitrateKbps ?? 0,
      audio_format: 'aac',
      stream_url: input.streamUrl ?? '',
      url_expire_at: input.urlExpireAt ?? 0,
      playable: input.playable ?? Boolean(input.streamUrl),
      copyright_available: input.copyrightAvailable ?? true,
      backup_sources: [],
      added_at: now,
      first_seen_at: now,
      last_matched_at: 0,
      blacklisted: false,
      tag_version: '',
      profile_status: 'pending',
    };
  },
};
