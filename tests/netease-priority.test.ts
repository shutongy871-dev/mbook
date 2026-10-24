import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateTrack } from '@/core/matching/candidate-pool';
const fixture = vi.hoisted(() => ({ pool: [] as CandidateTrack[] }));
vi.mock('@/core/matching/candidate-pool', () => ({
  assemblePool: async (blacklist: Set<string>) => fixture.pool.filter(c => !blacklist.has(c.id)),
}));
import { selectSongs } from '@/core/matching/pipeline';
import { DEFAULT_SETTINGS } from '@/core/db/settings.repo';
import { FeedbackTracker } from '@/core/feedback/attribution';

const track = (id: string, source: CandidateTrack['source'], emotion: number[]): CandidateTrack => ({
  id, source, emotion, title: id, artist: 'artist', url: '/audio', emotionConfidence: 1,
  tags: [], bpm: 80, hasLyrics: false, bitrateKbps: 192, durationSec: 120,
  popularityRaw: 0, vocalDensity: 0, playable: true, copyrightAvailable: true,
});
const target = [0, .8, 0, 0, 0, 0, 0, 0];
const select = (patch: Partial<Parameters<typeof selectSongs>[0]> = {}) => selectSongs({
  target, llmSceneTags: [], settings: DEFAULT_SETTINGS, feedback: new FeedbackTracker().toContext(),
  lastPlayedAt: new Map(), currentTrackId: null, externalEnabled: true, neteaseConnected: true,
  blacklist: new Set(), eventCount: 0, now: Date.now(), ...patch,
});
beforeEach(() => {
  fixture.pool = [track('builtin', 'builtin', target),
    track('netease:a', 'netease', [0, .6, 0, .1, 0, 0, 0, 0]),
    track('netease:b', 'netease', [0, .7, 0, 0, 0, 0, 0, 0])];
});
describe('logged-in NetEase priority', () => {
  it('selects by eight dimensions within NetEase even if a builtin is an exact match', async () => {
    const result = await select();
    expect(result.best?.candidate.id).toBe('netease:b');
    expect(result.targets.map(r => r.candidate.source)).toEqual(['netease', 'netease', 'builtin']);
  });
  it('uses ordinary matching when login is unconfirmed or external music is disabled', async () => {
    expect((await select({ neteaseConnected: false })).best?.candidate.id).toBe('builtin');
    const disabled = await select({ externalEnabled: false });
    expect(disabled.targets.map(r => r.candidate.id)).toEqual(['builtin']);
  });
  it('falls back to builtins when NetEase candidates fail hard filters or cooldown', async () => {
    fixture.pool[1]!.copyrightAvailable = false;
    fixture.pool[2]!.vocalDensity = 1;
    expect((await select()).best?.candidate.id).toBe('builtin');
    fixture.pool = [track('builtin', 'builtin', target), track('netease:a', 'netease', target)];
    expect((await select({ lastPlayedAt: new Map([['netease:a', Date.now()]]) })).best?.candidate.id).toBe('builtin');
  });
  it('keeps current playback for zero text and prefers NetEase for a zero cold start', async () => {
    expect((await select({ target: Array(8).fill(0), currentTrackId: 'builtin' })).selection?.reason).toBe('keep_current');
    expect((await select({ target: Array(8).fill(0) })).best?.candidate.source).toBe('netease');
  });
});
