import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db/dexie';
import {
  readingAnalysisRepo, READING_LOG_LIMIT, READING_LOG_RETENTION_MS,
} from '@/core/db/reading-analysis.repo';
import type { ReadingState } from '@/core/shared/contracts';

const state: ReadingState = {
  url: 'https://example.com/book', host: 'example.com', title: '测试书',
  extractor: 'generic', chapter: '第一章', window_id: 'window-1',
  state: 'focused', is_reading: true, page_active: true, stay_sec: 5,
  visible_text_len: 3, paragraph_count: 1, first_visible_index: 0,
  scroll_speed_sps: 0, reading_speed_cpm: 300, visible_text: '悲伤',
  updated_at: 1,
};
const playback = { trackId: 'cc01', title: '测试音乐' };

describe('persistent reading analysis', () => {
  beforeEach(async () => { await db.readingAnalyses.clear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('persists evidence, zero padding, context and threshold snapshot across reopen', async () => {
    await readingAnalysisRepo.record(state, 12, playback);
    db.close();
    await db.open();
    const [row] = await readingAnalysisRepo.page();
    expect(row).toMatchObject({
      tabId: 12, title: '测试书', chapter: '第一章', windowId: 'window-1', text: '悲伤',
      trackId: 'cc01', hasValidEmotion: true, selectionMode: 'eight-dimensional',
      thresholds: { maxDifference: .2, maxDistance: .5 },
      profile: { vector: [0, .5, 0, 0, 0, 0, 0, 0] },
    });
    expect(row!.profile!.dimensions.sadness.evidence[0]?.term).toBe('悲伤');
    expect(row!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('records zero-hit and negated windows and supports newest-first paging and clear', async () => {
    await readingAnalysisRepo.record(state, 1, playback);
    await readingAnalysisRepo.record({ ...state, visible_text: '他打开门。', window_id: 'window-2' }, 1, playback);
    await readingAnalysisRepo.record({ ...state, visible_text: '并不悲伤', window_id: 'window-3' }, 1, playback);
    expect(await readingAnalysisRepo.summary()).toEqual({ total: 3, hit: 1, zero: 2, failed: 0 });
    const [latest] = await readingAnalysisRepo.page(0, 1);
    expect(latest!.windowId).toBe('window-3');
    expect(latest!.profile!.vector).toEqual(Array(8).fill(0));
    expect(latest!.profile!.dimensions.sadness.evidence[0]?.excluded).toBe('negated');
    expect((await readingAnalysisRepo.page(1, 1))[0]!.windowId).toBe('window-2');
    expect(await readingAnalysisRepo.all()).toHaveLength(3);
    await readingAnalysisRepo.clear();
    expect(await readingAnalysisRepo.summary()).toEqual({ total: 0, hit: 0, zero: 0, failed: 0 });
  });

  it('records model-only evidence and distinguishes failed recognition from a valid zero vector', async () => {
    await readingAnalysisRepo.record(state, 1, playback, { profile: null, elapsedMs: 30,
      vector: Array(8).fill(0), source: 'model', model: 'qwen3.8-omni-flash', evidence: '中性叙述' });
    await readingAnalysisRepo.record(state, 1, playback, { profile: null, elapsedMs: 30,
      vector: null, source: 'model', model: 'qwen3.8-omni-flash', error: 'LLM HTTP 401' });
    expect(await readingAnalysisRepo.summary()).toEqual({ total: 2, hit: 0, zero: 1, failed: 1 });
    const [failed, neutral] = await readingAnalysisRepo.page();
    expect(failed).toMatchObject({ profile: null, matchingVector: null, error: 'LLM HTTP 401' });
    expect(neutral).toMatchObject({ profile: null, matchingVector: Array(8).fill(0), evidence: '中性叙述' });
  });

  it('prunes old records and caps retained data at the newest 1000 windows', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await readingAnalysisRepo.record(state, 1, playback);
    const [sample] = await readingAnalysisRepo.all();
    const { id: _id, ...fields } = sample!;
    await db.readingAnalyses.clear();
    await db.readingAnalyses.bulkAdd([
      { ...fields, ts: now - READING_LOG_RETENTION_MS - 1, windowId: 'expired' },
      ...Array.from({ length: READING_LOG_LIMIT }, (_, index) => ({
        ...fields, windowId: `retained-${index}`,
      })),
    ]);
    await readingAnalysisRepo.record({ ...state, window_id: 'newest' }, 1, playback);
    expect(await db.readingAnalyses.count()).toBe(READING_LOG_LIMIT);
    expect(await db.readingAnalyses.where('windowId').equals('expired').count()).toBe(0);
    expect(await db.readingAnalyses.where('windowId').equals('retained-0').count()).toBe(0);
    expect((await readingAnalysisRepo.page(0, 1))[0]!.windowId).toBe('newest');
  });
});
