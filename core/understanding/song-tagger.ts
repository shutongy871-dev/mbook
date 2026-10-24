// 歌曲八维画像：LLM或词典；音频特征只用于阅读干扰约束，不能推断细分情绪。
// 无 Key 路径：用阅读情绪词典分析歌名/专辑做本地兜底画像（status=audio_done），歌曲仍可匹配
import { z } from 'zod';
import type { Settings, Song, SongProfile } from '@/core/shared/contracts';
import { profilesRepo, preserveAudioProfile } from '@/core/db/profiles.repo';
import { chatJson, isLlmConfigured } from '@/core/llm/client';
import { scoreTextEmotions } from './emotion-scoring';
import { isEmotionVector } from './emotion';
import { logger } from '@/core/shared/logger';
import { db } from '@/core/db/dexie';
import { ATMOSPHERE_TAGS, EmotionSchema, TagSchema, mapTags, voteTags } from './taxonomy';
import { embedAtmosphere, embeddingIdentity } from '@/core/llm/embedding';

export const TAG_VERSION = 'emotion-8-v1';

const TagResultSchema = z.object({
  emotion: EmotionSchema,
  tags: z.array(TagSchema).max(12),
  semantic_text: z.string().max(200),
  confidence: z.number().min(0).max(1),
});

const SONG_TAG_SYSTEM = `你是纯音乐 BGM 画像专家。根据歌曲标题、艺人、专辑，判断它作为"阅读时背景音乐"的情绪画像。
只输出 JSON：{"emotion":[0,0,0,0,0,0,0,0],"tags":[中文氛围标签,最多8个],"semantic_text":"一句话描述适合的阅读场景","confidence":0到1}。
emotion固定顺序：喜悦、悲伤、温柔、希望、恐惧、愤怒、神秘、庄严；每维0到1强度，未知补0。标签白名单：${ATMOSPHERE_TAGS.join('/')}。`;

function localFallbackProfile(song: Song): SongProfile {
  const analysis = scoreTextEmotions(`${song.title} ${song.album} ${song.artist} ${(song.platform_tags ?? []).join(' ')} ${(song.playlist_tags ?? []).join(' ')}`);
  return {
    song_id: song.song_id,
    emotion_vector: analysis.vector.some(n => n > 0) ? analysis.vector : null,
    music_tags: mapTags([...(song.platform_tags ?? []), ...(song.playlist_tags ?? [])])
      .map(tag => ({ tag, confidence: .4 })),
    semantic_text: `本地元数据：${song.title} ${song.album}`,
    semantic_embedding: [],
    audio_features: null,
    popularity_raw: 0,
    popularity_score: 40,
    platform_tags: song.platform_tags ?? [],
  };
}

async function llmTag(song: Song, settings: Settings): Promise<SongProfile | null> {
  const raw = await chatJson(
    settings,
    SONG_TAG_SYSTEM,
    `歌曲标题：${song.title}\n艺人：${song.artist}\n专辑：${song.album}\n时长：${song.duration_sec}秒`,
  );
  const parsed = TagResultSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('[tag] LLM 画像格式校验失败:', song.title);
    return null;
  }
  const d = parsed.data;
  return {
    song_id: song.song_id,
    emotion_vector: d.emotion,
    music_tags: d.tags.map((t) => ({ tag: t, confidence: d.confidence })),
    semantic_text: d.semantic_text,
    semantic_embedding: [],
    audio_features: null,
    popularity_raw: 0,
    popularity_score: 40,
    platform_tags: [],
  };
}

// 打标状态机：已打同版本标不重复调；LLM 失败重试 1 次；仍失败 → 本地兜底（failed 也能匹配）
export async function tagSong(song: Song, settings: Settings): Promise<boolean> {
  const existing = await profilesRepo.get(song.song_id);
  if (existing?.audio_emotion && isEmotionVector(existing.audio_emotion.emotion)) return true;
  if (existing && isEmotionVector(existing.emotion_vector) && song.tag_version === TAG_VERSION && song.profile_status === 'llm_done') {
    if (settings.embedding_model && (!existing.semantic_embedding.length || existing.embedding_model !== embeddingIdentity(settings))) {
      existing.semantic_embedding = await embedAtmosphere(existing.semantic_text, settings);
      existing.embedding_model = existing.semantic_embedding.length ? embeddingIdentity(settings) : undefined;
      await profilesRepo.upsert(existing);
    }
    await profilesRepo.upsert(fuseSongProfile(song, existing, true));
    return true; // 同歌不二次调 LLM
  }

  await db.songs.update(song.song_id, { last_tag_attempt: Date.now() });
  let profile: SongProfile | null = null;
  let llmDone = false;
  if (isLlmConfigured(settings)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        profile = await llmTag(song, settings);
        if (profile) {
          llmDone = true;
          break;
        }
      } catch {
        // 重试 1 次
      }
    }
    if (!llmDone) logger.warn(`[tag] LLM 画像失败，转本地兜底：${song.title}`);
  }

  profile ??= localFallbackProfile(song);
  profile.audio_features = existing?.audio_features ?? null;
  profile.audio_analysis_status = existing?.audio_analysis_status ?? 'pending';
  if (existing?.popularity_updated_at) {
    profile.popularity_raw = existing.popularity_raw;
    profile.popularity_score = existing.popularity_score;
    profile.popularity_basis = existing.popularity_basis;
    profile.popularity_updated_at = existing.popularity_updated_at;
  }
  profile = fuseSongProfile(song, profile, llmDone);
  profile.semantic_embedding = await embedAtmosphere(profile.semantic_text, settings);
  profile.embedding_model = profile.semantic_embedding.length ? embeddingIdentity(settings) : undefined;
  // Version, state and profile become visible together, including no-Key upgrades.
  await db.transaction('rw', db.songs, db.songProfiles, async () => {
    profile = preserveAudioProfile(profile!, await db.songProfiles.get(song.song_id));
    await db.songProfiles.put(profile);
    await db.songs.update(song.song_id, { tag_version: TAG_VERSION,
      profile_status: profile.audio_emotion?.emotion || llmDone ? 'llm_done' : isLlmConfigured(settings) ? 'failed' : 'audio_done' });
  });
  return llmDone;
}

export function fuseSongProfile(song: Song, profile: SongProfile, llmDone: boolean): SongProfile {
  if (profile.audio_emotion && isEmotionVector(profile.audio_emotion.emotion))
    return { ...profile, emotion_vector: [...profile.audio_emotion.emotion], platform_tags: song.platform_tags ?? [] };
  const fallback = localFallbackProfile(song);
  profile.platform_tags = song.platform_tags ?? [];
  const platformTags = mapTags(profile.platform_tags);
  const playlistTags = mapTags(song.playlist_tags ?? []);
  const platformVector = scoreTextEmotions([...platformTags, ...playlistTags].join(' ')).vector;
  const platformEmotion = platformVector.some(n => n > 0) ? platformVector : null;
  const sources = [
    { weight: .5, emotion: llmDone ? profile.emotion_sources?.llm ?? profile.emotion_vector : null },
    { weight: .2, emotion: platformEmotion },
  ].filter(s => s.emotion);
  profile.emotion_sources = { llm: llmDone ? profile.emotion_sources?.llm ?? profile.emotion_vector ?? undefined : undefined,
    platform: platformEmotion ?? undefined };
  if (sources.length) {
    const weight = sources.reduce((n, s) => n + s.weight, 0);
    profile.emotion_vector = Array.from({ length: 8 }, (_, i) =>
      sources.reduce((n, s) => n + s.weight * s.emotion![i]!, 0) / weight);
  } else {
    profile.emotion_vector = fallback.emotion_vector;
  }
  const asVotes = (tags: string[]) => tags.map(tag => ({ tag, confidence: 1 }));
  if (llmDone) profile.llm_tags ??= profile.music_tags;
  const votes = voteTags([
    { weight: .45, tags: llmDone ? profile.llm_tags! : [] },
    { weight: .25, tags: asVotes(platformTags) }, { weight: .20, tags: asVotes(playlistTags) },
  ]);
  profile.music_tags = votes.length ? votes : fallback.music_tags;
  return profile;
}
