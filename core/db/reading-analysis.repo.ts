import { db } from './dexie';
import type { ReadingState } from '@/core/shared/contracts';
import { scoreTextEmotions, type EmotionProfile } from '@/core/understanding/emotion-scoring';
import { DEFAULT_EMOTION_THRESHOLDS } from '@/core/matching/emotion-selection';
import type { SelectResult } from '@/core/matching/pipeline';
import type { EmotionVector } from '@/core/shared/contracts';

export const READING_LOG_LIMIT = 1000;
export const READING_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReadingAnalysisRecord {
  id?: number;
  ts: number;
  tabId: number;
  url: string;
  title: string;
  chapter: string | null;
  windowId: string | null;
  text: string;
  textLength: number;
  elapsedMs: number;
  profile: EmotionProfile | null;
  hasValidEmotion: boolean;
  trackId: string | null;
  trackTitle: string | null;
  thresholds: typeof DEFAULT_EMOTION_THRESHOLDS;
  selectionMode: 'eight-dimensional';
  matchingVector?: EmotionVector | null;
  analysisSource?: 'dictionary' | 'model' | 'llm_fused';
  error?: string;
  model?: string;
  evidence?: string;
  selection?: {
    reason: string; selectedId: string; selectedTitle: string | null;
    attempts: NonNullable<SelectResult['selection']>['attempts'];
    comparison: NonNullable<SelectResult['selection']>['comparison'];
  };
}

export const readingAnalysisRepo = {
  async record(state: ReadingState, tabId: number, playback: {
    trackId: string | null; title: string | null;
  }, analysis?: {
    profile: EmotionProfile | null; elapsedMs: number; result?: SelectResult;
    vector: EmotionVector | null; source: 'dictionary' | 'model' | 'llm_fused';
    error?: string; model?: string; evidence?: string;
  }): Promise<void> {
    const text = state.visible_text ?? '';
    const started = performance.now();
    const profile = analysis ? analysis.profile : scoreTextEmotions(text);
    const vector = analysis ? analysis.vector : profile!.vector;
    const selected = analysis?.result?.selection;
    const row: ReadingAnalysisRecord = {
      ts: Date.now(), tabId, url: state.url, title: state.title, chapter: state.chapter,
      windowId: state.window_id, text, textLength: text.length,
      elapsedMs: analysis?.elapsedMs ?? performance.now() - started, profile,
      hasValidEmotion: Boolean(vector?.some(score => score > 0)),
      trackId: playback.trackId, trackTitle: playback.title,
      thresholds: { ...DEFAULT_EMOTION_THRESHOLDS }, selectionMode: 'eight-dimensional',
      matchingVector: vector, analysisSource: analysis?.source ?? 'dictionary',
      error: analysis?.error, model: analysis?.model, evidence: analysis?.evidence,
      selection: selected ? { reason: selected.reason, selectedId: selected.track.id,
        selectedTitle: analysis!.result!.ranked.find(r => r.candidate.id === selected.track.id)?.candidate.title ?? null,
        attempts: selected.attempts, comparison: selected.comparison } : undefined,
    };
    await db.transaction('rw', db.readingAnalyses, async () => {
      await db.readingAnalyses.add(row);
      await db.readingAnalyses.where('ts').below(row.ts - READING_LOG_RETENTION_MS).delete();
      const overflow = await db.readingAnalyses.count() - READING_LOG_LIMIT;
      if (overflow > 0) {
        const oldest = await db.readingAnalyses.orderBy('id').limit(overflow).primaryKeys();
        await db.readingAnalyses.bulkDelete(oldest);
      }
    });
  },
  async page(offset = 0, limit = 20): Promise<ReadingAnalysisRecord[]> {
    return db.readingAnalyses.orderBy('id').reverse().offset(offset).limit(limit).toArray();
  },
  async summary(): Promise<{ total: number; hit: number; zero: number; failed: number }> {
    const rows = await db.readingAnalyses.toArray();
    const hit = rows.filter(row => row.hasValidEmotion).length;
    const failed = rows.filter(row => row.error).length;
    return { total: rows.length, hit, zero: rows.length - hit - failed, failed };
  },
  async all(): Promise<ReadingAnalysisRecord[]> {
    return db.readingAnalyses.orderBy('id').reverse().toArray();
  },
  async clear(): Promise<void> {
    await db.readingAnalyses.clear();
  },
};
