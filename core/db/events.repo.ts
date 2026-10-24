// 用户反馈事件仓库（Step 7 反馈学习）：完播 / 切歌 / 喜欢 / 点踩 / 关插件
import { db } from './dexie';
import type { DecisionSnapshot, UserAction, UserEvent } from '@/core/shared/contracts';

export interface ActionCounts {
  plays: number;
  completes: number;
  skips: number;
  likes: number;
  dislikes: number;
  manualSwitches: number;
}

export const eventsRepo = {
  async record(input: {
    action: UserAction;
    songId: string;
    windowId: string | null;
    sceneBucket: string;
    features?: Record<string, number | string>;
    decision?: DecisionSnapshot;
  }): Promise<UserEvent> {
    const ev: UserEvent = {
      ts: Date.now(),
      window_id: input.windowId ?? 'unknown',
      song_id: input.songId,
      action: input.action,
      scene_bucket: input.sceneBucket,
      context_features: input.features ?? {},
      decision: input.decision,
    };
    ev.id = await db.userEvents.put(ev);
    return ev;
  },

  async totalCount(): Promise<number> {
    return db.userEvents.filter(e => e.action !== 'play_start' && e.action !== 'sustained_play').count();
  },

  async countsForSong(songId: string): Promise<ActionCounts> {
    const rows = await db.userEvents.where('song_id').equals(songId).toArray();
    return this.tally(rows.map((r) => r.action));
  },

  // 近窗口内的动作（切歌频率惩罚用）
  async recentActions(sinceMs: number): Promise<UserEvent[]> {
    const sinceTs = Date.now() - sinceMs;
    const all = await db.userEvents.toArray();
    return all.filter((e) => e.ts >= sinceTs);
  },

  tally(actions: UserAction[]): ActionCounts {
    const c: ActionCounts = {
      plays: 0,
      completes: 0,
      skips: 0,
      likes: 0,
      dislikes: 0,
      manualSwitches: 0,
    };
    for (const a of actions) {
      if (a === 'play_start') {
        c.plays++;
      } else if (a === 'full_play') {
        c.completes += 1;
      } else if (a === 'manual_switch') {
        c.manualSwitches += 1;
      } else if (a === 'quick_skip') {
        c.skips += 1;
      } else if (a === 'like') c.likes += 1;
      else if (a === 'dislike') c.dislikes += 1;
    }
    return c;
  },

  async dislikeCount(): Promise<number> {
    const rows = await db.userEvents.filter((e) => e.action === 'dislike').toArray();
    return new Set(rows.map(e => e.song_id)).size;
  },
};
