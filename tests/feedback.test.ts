import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db/dexie';
import { FeedbackTracker } from '@/core/feedback/attribution';
import { eventsRepo } from '@/core/db/events.repo';
import { sceneBucket } from '@/core/shared/scene';
import { featureAffinity, preferenceKeys } from '@/core/feedback/feature-preferences';
const context = { windowId: 'chapter-1:paragraph-10', sceneBucket: 'v1_a1_t1_novel' };
beforeEach(async () => {
  await db.userEvents.clear(); await db.sceneStats.clear(); await db.settings.clear(); await db.songs.clear();
});
describe('durable feedback attribution', () => {
  it('learns observed feature preferences and completion friendliness across restart', async () => {
    const tracker = new FeedbackTracker();
    const keys = preferenceKeys({ bpm: 125, vocalDensity: .7, energyCurve: [.8, .9] });
    const ctx = { ...context, features: { preference_keys: keys.join('|') } };
    await tracker.recordLike('song', ctx);
    expect(featureAffinity(keys, tracker.toContext().featurePreferences)).toBeCloseTo(.03);
    await tracker.recordQuickSkip('song', ctx);
    expect(featureAffinity(keys, tracker.toContext().featurePreferences)).toBeCloseTo(-.01);
    await tracker.recordFullPlay('other', context);
    expect(tracker.toContext().friendlinessBonus?.get('other')).toBe(.03);
    expect(preferenceKeys({})).toEqual([]);
    const restarted = new FeedbackTracker();
    await restarted.hydrate();
    expect(restarted.toContext()).toEqual(tracker.toContext());
  });
  it('counts a playback only once and preserves the actual text window', async () => {
    const tracker = new FeedbackTracker();
    await tracker.recordPlay('song', 'artist', context);
    await tracker.recordFullPlay('song', context);
    expect(tracker.toContext(context.sceneBucket).playCounts.get('song')).toBe(1);
    expect(tracker.toContext(context.sceneBucket).completionRate.get('song')).toBe(1);
    const events = await db.userEvents.toArray();
    expect(events.every(e => e.window_id === context.windowId)).toBe(true);
    expect(eventsRepo.tally(events.map(e => e.action))).toMatchObject({ plays: 1, completes: 1 });
    expect(await eventsRepo.totalCount()).toBe(1); // exposure is not a learning label
  });
  it('keeps scenes separate and reproduces learning state after worker restart', async () => {
    const tracker = new FeedbackTracker();
    await tracker.recordPlay('song', 'artist', context);
    await tracker.recordLike('song', context);
    await tracker.recordManualSwitch('song', context, 15_000);
    const before = tracker.toContext(context.sceneBucket);
    expect(tracker.toContext('another_scene').sceneMatch.has('song')).toBe(false);
    const restarted = new FeedbackTracker();
    await restarted.hydrate();
    expect(restarted.toContext(context.sceneBucket)).toEqual(before);
    expect((await db.sceneStats.get([context.sceneBucket, 'song']))?.play_count).toBe(1);
    const tally = eventsRepo.tally((await db.userEvents.toArray()).map(e => e.action));
    expect(tally).toMatchObject({ plays: 1, skips: 1, manualSwitches: 1 });
  });
  it('persists exclusions for all sources', async () => {
    const tracker = new FeedbackTracker();
    await tracker.recordDislike('cc01', context);
    const restarted = new FeedbackTracker();
    await restarted.hydrate();
    expect(restarted.blacklist().has('cc01')).toBe(true);
  });
  it('bins all eight emotion dimensions and content type', () => {
    expect(sceneBucket([0, .8, 0, 0, .7, 0, 0, 0], 'novel')).toBe('e8_02002000_novel');
  });
});
