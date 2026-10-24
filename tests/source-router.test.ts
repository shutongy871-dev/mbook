import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/core/sources', () => ({ resolvePlayableUrl: vi.fn(), resolveBackupUrls: vi.fn() }));
import { resolveBackupUrls, resolvePlayableUrl } from '@/core/sources';
import { routePlayableUrl } from '@/core/sources/source-router';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('bounded source address race', () => {
  it('uses a ready backup immediately even when the primary is hanging', async () => {
    let primarySignal!: AbortSignal;
    vi.mocked(resolvePlayableUrl).mockImplementationOnce(async (_id, signal) => {
      primarySignal = signal!;
      return await new Promise(() => {});
    });
    vi.mocked(resolveBackupUrls).mockResolvedValueOnce(['https://backup.invalid/full']);
    expect(await routePlayableUrl('song')).toEqual({ url: 'https://backup.invalid/full', bitrate: 0 });
    expect(primarySignal.aborted).toBe(true);
  });
  it('accepts an uncached response that arrives after the old 100ms cutoff', async () => {
    vi.mocked(resolvePlayableUrl).mockResolvedValueOnce(null);
    vi.mocked(resolveBackupUrls).mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 800));
      return ['https://backup.invalid/full'];
    });
    const routed = routePlayableUrl('song');
    await vi.advanceTimersByTimeAsync(800);
    expect((await routed)?.url).toBe('https://backup.invalid/full');
  });
  it('cancels both lookups at the caller deadline so local fallback can proceed', async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(resolvePlayableUrl).mockImplementationOnce(async (_id, signal) => {
      signals.push(signal!); return await new Promise(() => {});
    });
    vi.mocked(resolveBackupUrls).mockImplementationOnce(async (_id, signal) => {
      signals.push(signal!); return await new Promise(() => {});
    });
    const routed = routePlayableUrl('song', 1800);
    await vi.advanceTimersByTimeAsync(1799);
    expect(signals.every(s => !s.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await routed).toBeNull();
    expect(signals).toHaveLength(2);
    expect(signals.every(s => s.aborted)).toBe(true);
  });
});
