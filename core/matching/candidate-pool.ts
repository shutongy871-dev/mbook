// 候选池：CC0 内置曲（永远可用）+ 已画像的外部歌曲（Dexie）
// 外部歌曲在播放前才解析流地址；未画像/拉黑的歌曲不进池（方案 6.4）
import { CC0_TRACKS } from '@/assets/cc0/manifest';
import { songsRepo } from '@/core/db/songs.repo';
import { profilesRepo } from '@/core/db/profiles.repo';
import type { Cc0Track, EmotionVector, Song, SongProfile } from '@/core/shared/contracts';
import { mapTags } from '@/core/understanding/taxonomy';
import builtinFeatures from '@/assets/cc0/features.json';
import { isEmotionVector } from '@/core/understanding/emotion';

export interface CandidateTrack {
  id: string; // CC0: 'cc01'；外部: song_id 'netease:123'
  source: 'builtin' | 'netease';
  title: string;
  artist: string;
  url: string; // 内置为静态地址；外部为空串（播放前 resolve）
  emotion: EmotionVector;
  emotionConfidence: number; // 0-1，画像来源可信度
  tags: string[]; // 氛围标签（中文）
  bpm: number; // 未知为 0
  hasLyrics: boolean;
  bitrateKbps: number;
  audioFormat?: string;
  popularityRaw: number;
  popularityScore?: number;
  durationSec: number;
  tagConfidence?: Record<string, number>;
  embedding?: number[];
  embeddingModel?: string;
  vocalDensity?: number | null;
  dynamicRange?: number;
  energyCurve?: number[];
  spectralCentroidHz?: number;
  playable?: boolean;
  copyrightAvailable?: boolean;
  loadFailRate?: number;
  sourceStability?: number;
  lastMatchedAt?: number;
  addedAt?: number;
  channels?: string[];
}

export async function assemblePool(blacklist: Set<string>): Promise<CandidateTrack[]> {
  const pool: CandidateTrack[] = [];

  for (const t of CC0_TRACKS) {
    if (blacklist.has(t.id)) continue;
    pool.push(cc0ToCandidate(t));
  }

  try {
    const songs = await songsRepo.listSelectable();
    for (const s of songs) {
      if (blacklist.has(s.song_id)) continue;
      if (s.profile_status === 'pending' || s.profile_status === 'failed') {
        // failed 仍可匹配（方案），但需有画像兜底；pending 尚无画像不进池
        if (s.profile_status === 'pending') continue;
      }
      const profile = await profilesRepo.get(s.song_id);
      if (!isEmotionVector(profile?.emotion_vector) || !profile.emotion_vector.some(n => n > 0)) continue;
      pool.push(songToCandidate(s, profile));
    }
  } catch {
    // Dexie 异常时 CC0 仍可用
  }

  return pool;
}

// 选歌与诊断共用字段映射，避免音质、人声等口径漂移。
export function songToCandidate(s: Song, profile: SongProfile | undefined, now = Date.now()): CandidateTrack {
  return {
        id: s.song_id,
        source: 'netease',
        title: s.title,
        artist: s.artist,
        url: s.stream_url ?? '',
        emotion: profile?.emotion_vector ?? Array(8).fill(0),
        emotionConfidence: s.profile_status === 'llm_done' ? 0.9 : 0.45,
        tags: profile?.music_tags.map((t) => t.tag) ?? [],
        bpm: profile?.audio_features?.bpm ?? 0,
        hasLyrics: s.has_lyrics,
        bitrateKbps: s.bitrate_kbps,
        audioFormat: s.audio_format,
        popularityRaw: profile?.popularity_raw ?? 0,
        popularityScore: profile?.popularity_score,
        durationSec: s.duration_sec,
        tagConfidence: Object.fromEntries(profile?.music_tags.map(t => [t.tag, t.confidence]) ?? []),
        embedding: profile?.semantic_embedding,
        embeddingModel: profile?.embedding_model,
        vocalDensity: profile?.audio_features?.vocal_density,
        dynamicRange: profile?.audio_features?.dynamic_range,
        energyCurve: profile?.audio_features?.energy_curve,
        spectralCentroidHz: profile?.audio_features?.spectral_centroid_hz,
        playable: s.playable,
        copyrightAvailable: s.copyright_available,
        loadFailRate: (() => {
          const attempts = (s.load_attempts ?? []).filter(a => now - a.ts < 7 * 86_400_000);
          return attempts.length ? attempts.filter(a => !a.ok).length / attempts.length : 0;
        })(),
        sourceStability: s.playable ? 1 : 0,
        lastMatchedAt: s.last_matched_at,
        addedAt: s.added_at,
        channels: s.source_channels,
  };
}

function cc0ToCandidate(t: Cc0Track): CandidateTrack {
  return {
    id: t.id,
    source: 'builtin',
    title: t.title,
    artist: t.artist,
    url: t.url,
    emotion: t.emotion,
    emotionConfidence: 0.8, // 预置人工画像
    tags: mapTags(t.tags.concat(t.mood_label)),
    bpm: t.bpm,
    hasLyrics: false,
    bitrateKbps: t.bitrate_kbps,
    audioFormat: 'aac',
    popularityRaw: 0,
    durationSec: t.duration_sec,
    playable: true,
    copyrightAvailable: true,
    vocalDensity: 0,
    dynamicRange: builtinFeatures[t.id as keyof typeof builtinFeatures]?.dynamic_range,
    energyCurve: builtinFeatures[t.id as keyof typeof builtinFeatures]?.energy_curve,
    sourceStability: 1,
  };
}
