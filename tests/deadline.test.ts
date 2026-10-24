import { afterEach, describe, expect, it, vi } from 'vitest';
import { withinDeadline } from '@/core/shared/deadline';
vi.mock('wxt/browser', () => ({ browser: { cookies: { get: async () => null } } }));
vi.mock('@/core/sources/netease-crypto', () => ({ weapi: async () => ({ params: '', encSecKey: '' }) }));
import { neteaseAdapter } from '@/core/sources/netease';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('foreground metadata deadline', () => {
  it('cancels a queued URL lookup before it can send a late request', async () => {
    vi.useFakeTimers();
    let release!: (response: unknown) => void;
    const fetcher = vi.fn(() => new Promise(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const sync = neteaseAdapter.fetchLibrary();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const foreground = withinDeadline(signal => neteaseAdapter.resolveUrl({
      source: 'netease', sourceSongId: '1', title: 'A', artist: 'B', album: '', durationSec: 120,
      hasLyrics: true, bitrateKbps: 0, popularityRaw: 0, streamUrl: '', urlExpireAt: 0, playable: false,
    }, signal), 1500, null);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await foreground).toBeNull();
    release({ ok: true, json: async () => ({ code: 200 }) });
    await sync;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('settles active timeouts and never starts work when the budget has expired', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const result = withinDeadline(s => { signal = s; return new Promise<string>(() => {}); }, 100, 'fallback');
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe('fallback');
    expect(signal.aborted).toBe(true);
    const work = vi.fn(async () => 'late');
    expect(await withinDeadline(work, 0, 'fallback')).toBe('fallback');
    expect(work).not.toHaveBeenCalled();
  });
});
