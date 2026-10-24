// 歌曲画像仓库：情绪向量 / 标签 / 语义文本（Step 5 LLM 打标产物）
import { db } from './dexie';
import type { SongProfile } from '@/core/shared/contracts';
import { isEmotionVector } from '@/core/understanding/emotion';

export function preserveAudioProfile(profile: SongProfile, current?: SongProfile): SongProfile {
  const audio = current?.audio_emotion?.emotion && isEmotionVector(current.audio_emotion.emotion)
    ? current.audio_emotion : profile.audio_emotion;
  if (audio && isEmotionVector(audio.emotion)) return {
    ...profile, audio_emotion: audio, emotion_vector: [...audio.emotion],
    semantic_text: current?.audio_emotion === audio ? current.semantic_text : profile.semantic_text,
    semantic_embedding: current?.audio_emotion === audio ? current.semantic_embedding : profile.semantic_embedding,
    embedding_model: current?.audio_emotion === audio ? current.embedding_model : profile.embedding_model,
  };
  return profile;
}

export const profilesRepo = {
  async get(songId: string): Promise<SongProfile | undefined> {
    return db.songProfiles.get(songId);
  },

  async upsert(profile: SongProfile): Promise<void> {
    await db.transaction('rw', db.songProfiles, async () => {
      await db.songProfiles.put(preserveAudioProfile(profile, await db.songProfiles.get(profile.song_id)));
    });
  },

  async count(): Promise<number> {
    return db.songProfiles.count();
  },
};
