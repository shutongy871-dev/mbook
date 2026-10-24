import { eventsRepo } from '@/core/db/events.repo';
import { statsRepo } from '@/core/db/stats.repo';
import { songsRepo } from '@/core/db/songs.repo';
import { db } from '@/core/db/dexie';
import type { FeedbackContext } from '@/core/matching/final-rank';
import type { DecisionSnapshot, UserAction, UserEvent } from '@/core/shared/contracts';
import { localLearning } from '@/core/matching/learning';
import { logger } from '@/core/shared/logger';

const BLACKLIST_KEY = 'mbook_blacklist';
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
export interface Attribution {
  windowId: string | null;
  sceneBucket: string;
  features?: Record<string, number | string>;
  decision?: DecisionSnapshot;
}

export class FeedbackTracker {
  private affinity = new Map<string, number>();
  private sceneMatchMap = new Map<string, number>();
  private completes = new Map<string, number>();
  private skips = new Map<string, number>();
  private plays = new Map<string, number>();
  totalDecisions = 0;
  private quickSkipped = new Set<string>();
  private recentSwitches: number[] = [];
  private artistRecent: string[] = [];
  private blocked = new Set<string>();
  private artistAffinity = new Map<string, number>();
  private styleAffinity = new Map<string, number>();
  private featurePreferences = new Map<string, number>();
  private friendlinessBonus = new Map<string, number>();
  private recentPlays: Array<{ artist: string; ts: number }> = [];
  private hydration: Promise<void> | null = null;

  hydrate(): Promise<void> {
    return this.hydration ??= (async () => {
      const [events, scenes, row, songs] = await Promise.all([
        db.userEvents.orderBy('ts').toArray(), db.sceneStats.toArray(),
        db.settings.get(BLACKLIST_KEY), db.songs.filter(s => s.blacklisted).toArray(),
      ]);
      for (const event of events) this.apply(event);
      for (const scene of scenes)
        this.sceneMatchMap.set(`${scene.scene_bucket}|${scene.song_id}`, scene.match_score);
      const ids = (row?.value as { cc0?: string[] } | undefined)?.cc0 ?? [];
      for (const id of [...ids, ...songs.map(s => s.song_id)]) this.blocked.add(id);
    })();
  }

  private apply(e: UserEvent): void {
    const id = e.song_id;
    if (e.action === 'play_start') this.totalDecisions++;
    const bump = (map: Map<string, number>, delta: number) => map.set(id, (map.get(id) ?? 0) + delta);
    if (e.action === 'play_start') {
      bump(this.plays, 1);
      this.artistRecent.push(String(e.context_features.artist ?? ''));
      this.artistRecent = this.artistRecent.slice(-2);
      this.recentPlays.push({ artist: String(e.context_features.artist ?? ''), ts: e.ts });
    }
    if (e.action === 'full_play') {
      bump(this.completes, 1);
      this.friendlinessBonus.set(id, Math.min(.3, (this.friendlinessBonus.get(id) ?? 0) + .03));
      this.quickSkipped.delete(id);
    }
    if (e.action === 'quick_skip') {
      bump(this.skips, 1);
      this.quickSkipped.add(id);
    }
    if (e.action === 'like') this.affinity.set(id, clamp((this.affinity.get(id) ?? 0) + .05));
    if (e.action === 'dislike') this.affinity.set(id, clamp((this.affinity.get(id) ?? 0) - .2));
    const preferenceDelta = ({ like: .03, full_play: .03, quick_skip: -.04, dislike: -.08 } as Partial<Record<UserAction, number>>)[e.action] ?? 0;
    if (preferenceDelta) {
      const artist = String(e.context_features.artist ?? '');
      if (artist) this.artistAffinity.set(artist, clamp((this.artistAffinity.get(artist) ?? 0) + preferenceDelta));
      for (const tag of String(e.context_features.tags ?? '').split('|').filter(Boolean))
        this.styleAffinity.set(tag, clamp((this.styleAffinity.get(tag) ?? 0) + preferenceDelta));
    }
    for (const key of String(e.context_features.preference_keys ?? '').split('|').filter(Boolean)) {
      const delta = e.action === 'like' ? .03 :
        e.action === 'quick_skip' && ['bpm:fast', 'vocal:high', 'energy:high'].includes(key) ? -.04 : 0;
      if (delta) this.featurePreferences.set(key, clamp((this.featurePreferences.get(key) ?? 0) + delta));
    }
    this.recentPlays = this.recentPlays.filter(p => Date.now() - p.ts < 3_600_000);
    if (e.action === 'manual_switch') this.recentSwitches.push(e.ts);
    this.recentSwitches = this.recentSwitches.filter(ts => Date.now() - ts < 300_000);
  }

  blacklist(): Set<string> { return new Set(this.blocked); }

  async recordPlay(songId: string, artist: string, context: Attribution): Promise<void> {
    await this.persist('play_start', songId, { ...context,
      features: { ...context.features, artist } });
    await statsRepo.bump(context.sceneBucket, songId, 0, { play: 1 });
  }

  async recordFullPlay(songId: string, context: Attribution, _matchScore = 0): Promise<void> {
    await this.persist('full_play', songId, context);
    await this.bumpScene(songId, context, .04, { complete: 1 });
  }

  async recordQuickSkip(songId: string, context: Attribution, _matchScore = 0): Promise<void> {
    await this.persist('quick_skip', songId, context);
    await this.bumpScene(songId, context, -.08, { skip: 1 });
  }

  async recordManualSwitch(songId: string, context: Attribution, durationMs: number): Promise<void> {
    await this.persist('manual_switch', songId, this.isQuickSkip(durationMs) ?
      { ...context, features: { ...context.features, learning_excluded: 1 } } : context);
    if (this.isQuickSkip(durationMs)) await this.recordQuickSkip(songId, context);
  }

  async recordSustainedPlay(songId: string, context: Attribution): Promise<void> {
    await this.persist('sustained_play', songId, context);
  }

  async recordLike(songId: string, context: Attribution): Promise<void> {
    await this.persist('like', songId, context);
    await this.bumpScene(songId, context, .08);
  }

  async recordDislike(songId: string, context: Attribution): Promise<void> {
    await this.persist('dislike', songId, context);
    this.blocked.add(songId);
    await songsRepo.setBlacklisted(songId, true);
    await db.settings.put({ key: BLACKLIST_KEY, value: { cc0: [...this.blocked] } });
    await this.bumpScene(songId, context, -.12);
  }

  async recordClosePlugin(songId = '', context: Attribution = { windowId: null, sceneBucket: 'global' }): Promise<void> {
    await this.persist('close_plugin', songId, context);
  }

  noteSwitch(): void { this.recentSwitches.push(Date.now()); }

  toContext(sceneBucket = 'unknown'): FeedbackContext {
    const completionRate = new Map<string, number>();
    const skipRate = new Map<string, number>();
    for (const [id, p] of this.plays) {
      completionRate.set(id, Math.min(1, (this.completes.get(id) ?? 0) / Math.max(1, p)));
      skipRate.set(id, Math.min(1, (this.skips.get(id) ?? 0) / Math.max(1, p)));
    }
    const sceneMatch = new Map<string, number>();
    const prefix = `${sceneBucket}|`;
    for (const [key, value] of this.sceneMatchMap)
      if (key.startsWith(prefix)) sceneMatch.set(key.slice(prefix.length), value);
    const recentArtistCounts = new Map<string, number>();
    for (const p of this.recentPlays.filter(p => Date.now() - p.ts < 3_600_000))
      recentArtistCounts.set(p.artist, (recentArtistCounts.get(p.artist) ?? 0) + 1);
    return {
      affinity: new Map(this.affinity), sceneMatch, completionRate, skipRate,
      quickSkipped: new Set(this.quickSkipped), recentArtists: [...this.artistRecent],
      recentSwitchCount: this.recentSwitches.filter(t => Date.now() - t < 300_000).length,
      totalDecisions: this.totalDecisions, playCounts: new Map(this.plays),
      artistAffinity: new Map(this.artistAffinity), styleAffinity: new Map(this.styleAffinity),
      featurePreferences: new Map(this.featurePreferences), friendlinessBonus: new Map(this.friendlinessBonus),
      recentArtistCounts,
    };
  }

  isQuickSkip(ms: number): boolean { return ms > 0 && ms < 30_000; }

  private async bumpScene(songId: string, context: Attribution, delta: number,
    counts: { complete?: number; skip?: number } = {}): Promise<void> {
    const key = `${context.sceneBucket}|${songId}`;
    this.sceneMatchMap.set(key, clamp((this.sceneMatchMap.get(key) ?? 0) + delta));
    await statsRepo.bump(context.sceneBucket, songId, 0, { ...counts, matchDelta: delta });
  }

  private async persist(action: UserAction, songId: string, context: Attribution): Promise<void> {
    await this.hydrate();
    const event = await eventsRepo.record({ action, songId, ...context });
    this.apply(event);
    // Feedback must succeed even if model storage/training fails; hydration replays the event later.
    await localLearning.observe().catch(e => logger.warn('[learning]', e));
  }
}

export const feedbackTracker = new FeedbackTracker();
