import { describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: { runtime: { getURL: (p: string) => p } } }));
vi.mock('@/core/db/songs.repo', () => ({ songsRepo: { listSelectable: async () => [] } }));
import { selectSongs } from '@/core/matching/pipeline';
import { FeedbackTracker } from '@/core/feedback/attribution';
import { DEFAULT_SETTINGS } from '@/core/db/settings.repo';
import { CC0_TRACKS } from '@/assets/cc0/manifest';

describe('continuous built-in fallback', () => {
  it('uses the actual eight-dimensional selector despite contrary popularity/preferences', async () => {
    const target = CC0_TRACKS.find(t => t.id === 'cc03')!.emotion;
    const feedback = new FeedbackTracker().toContext();
    feedback.affinity.set('cc02', 1);
    const result = await selectSongs({
      target, llmSceneTags: ['温暖治愈'], settings: DEFAULT_SETTINGS, feedback,
      lastPlayedAt: new Map(), currentTrackId: 'cc02', externalEnabled: false,
      blacklist: new Set(), eventCount: 1000, now: Date.now(),
    });
    expect(result.best?.candidate.id).toBe('cc03');
    expect(result.selection?.track.id).toBe('cc03');
    expect(result.selection?.comparison?.cosine).toBeCloseTo(1);
    expect(result.selection?.attempts[0]).toEqual({ maxDifference: .2, maxDistance: .5, passedCount: 1 });
    expect(result.best?.finalScore).toBeCloseTo(100);
  });
  it('keeps a playable current track for zero text and starts cc10 on a zero cold start', async () => {
    const input = {
      target: Array(8).fill(0), llmSceneTags: [], settings: DEFAULT_SETTINGS,
      feedback: new FeedbackTracker().toContext(), lastPlayedAt: new Map<string, number>(),
      currentTrackId: 'cc03', externalEnabled: false, blacklist: new Set<string>(),
      eventCount: 0, now: Date.now(),
    };
    expect((await selectSongs(input)).selection).toMatchObject({ reason: 'keep_current', track: { id: 'cc03' } });
    expect((await selectSongs({ ...input, currentTrackId: null })).selection)
      .toMatchObject({ reason: 'fallback', track: { id: 'cc10' } });
  });
  it('rotates within the top five by oldest play time while keeping an exact current best stable', async () => {
    const now = Date.now();
    const target = CC0_TRACKS.find(t => t.id === 'cc03')!.emotion;
    const base = {
      target, llmSceneTags: [], settings: DEFAULT_SETTINGS,
      feedback: new FeedbackTracker().toContext(), currentTrackId: null,
      externalEnabled: false, blacklist: new Set<string>(), eventCount: 0, now,
    };
    const first = await selectSongs({ ...base, lastPlayedAt: new Map() });
    const firstId = first.best!.candidate.id;
    const rotated = await selectSongs({ ...base,
      lastPlayedAt: new Map([[firstId, now - 31 * 60_000]]) });
    expect(rotated.best?.candidate.id).not.toBe(firstId);
    expect(first.targets.slice(0, 5).map(item => item.candidate.id))
      .toContain(rotated.best?.candidate.id);
    const stable = await selectSongs({ ...base, currentTrackId: firstId,
      lastPlayedAt: new Map([[firstId, now]]) });
    expect(stable.best?.candidate.id).toBe(firstId);
  });
  it('relaxes only cooldown after pool exhaustion, never the blacklist', async () => {
    const now = Date.now();
    const blocked = new Set(['cc02', 'cc03']);
    const result = await selectSongs({
      target: Array(8).fill(0), llmSceneTags: [],
      settings: DEFAULT_SETTINGS, feedback: new FeedbackTracker().toContext(),
      lastPlayedAt: new Map(CC0_TRACKS.map(t => [t.id, now - 1000])),
      currentTrackId: 'cc01', excludeCurrent: true, externalEnabled: false, blacklist: blocked, eventCount: 0, now,
    });
    expect(result.best).not.toBeNull();
    expect(result.targets.every(r => !blocked.has(r.candidate.id) && r.candidate.id !== 'cc01')).toBe(true);
  });
  it('does not invent candidates when every song was blocked', async () => {
    const result = await selectSongs({
      target: Array(8).fill(0), llmSceneTags: [],
      settings: DEFAULT_SETTINGS, feedback: new FeedbackTracker().toContext(),
      lastPlayedAt: new Map(), currentTrackId: null, externalEnabled: false,
      blacklist: new Set(CC0_TRACKS.map(t => t.id)), eventCount: 0, now: Date.now(),
    });
    expect(result.targets).toEqual([]);
  });
});
