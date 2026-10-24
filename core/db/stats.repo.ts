// 场景统计仓库：场景桶（情绪档位）× 歌曲的匹配分累加（反馈归因更新）
import { db } from './dexie';
import type { SceneStat } from '@/core/shared/contracts';

export const statsRepo = {
  async bump(
    sceneBucket: string,
    songId: string,
    matchScore: number,
    delta: { play?: number; complete?: number; skip?: number; matchDelta?: number },
  ): Promise<void> {
    await db.transaction('rw', db.sceneStats, async () => {
    const key: [string, string] = [sceneBucket, songId];
    const existing = await db.sceneStats.get(key);
    const now = Date.now();
    if (existing) {
      const next: SceneStat = {
        ...existing,
        match_score: Math.max(-1, Math.min(1, existing.match_score + (delta.matchDelta ?? 0))),
        play_count: existing.play_count + (delta.play ?? 0),
        complete_count: existing.complete_count + (delta.complete ?? 0),
        skip_count: existing.skip_count + (delta.skip ?? 0),
        updated_at: now,
      };
      await db.sceneStats.put(next);
    } else {
      await db.sceneStats.put({
        scene_bucket: sceneBucket,
        song_id: songId,
        match_score: Math.max(-1, Math.min(1, delta.matchDelta ?? 0)),
        play_count: delta.play ?? 0,
        complete_count: delta.complete ?? 0,
        skip_count: delta.skip ?? 0,
        updated_at: now,
      });
    }
    });
  },

  // 某首歌在某场景下的平均匹配分（0-1），无记录为 0
  async sceneMatch(sceneBucket: string, songId: string): Promise<number> {
    const row = await db.sceneStats.get([sceneBucket, songId]);
    if (!row) return 0;
    return Math.max(-1, Math.min(1, row.match_score));
  },
};
