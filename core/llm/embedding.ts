import type { Settings } from '@/core/shared/contracts';
import { apiUrl, isLlmConfigured } from './client';

export function embeddingIdentity(settings: Settings): string {
  return `${settings.llm_endpoint.trim().replace(/\/(?:chat\/completions|embeddings)\/?$/, '').replace(/\/+$/, '')}|${settings.embedding_model?.trim() ?? ''}`;
}
// Only atmosphere descriptions enter this bounded memory cache; no reading text is persisted.
const cache = new Map<string, number[]>();
const inflight = new Map<string, Promise<number[]>>();
const failed = new Map<string, number>();

// Diagnostic calls bypass production caches/backoff, but use exactly the same transport/validation.
export async function requestEmbedding(text: string, settings: Settings, timeoutMs = 1500): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(settings.llm_endpoint, 'embeddings'), {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.llm_key.trim()}` },
      body: JSON.stringify({ model: settings.embedding_model, input: text.slice(0, 500) }),
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
    const data = await response.json();
    const vector: unknown = data.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length < 2 || vector.length > 65536 ||
      !vector.every(x => typeof x === 'number' && Number.isFinite(x)) || !vector.some(x => x !== 0)) {
      throw new Error('invalid embedding');
    }
    return vector as number[];
  } finally { clearTimeout(timer); }
}

export async function embedAtmosphere(text: string, settings: Settings): Promise<number[]> {
  // Provider chat and embedding availability differ. No guessed model / silent cross-model comparison.
  if (!isLlmConfigured(settings) || !settings.embedding_model?.trim() || !text.trim()) return [];
  // Credential participates only in ephemeral cache keys, never the persisted model identity.
  // A corrected Key must bypass backoff from the previous invalid credential.
  const key = JSON.stringify([embeddingIdentity(settings), settings.llm_key.trim(), text]);
  if (cache.has(key)) return cache.get(key)!;
  if ((failed.get(key) ?? 0) > Date.now()) return [];
  if (inflight.has(key)) return inflight.get(key)!;
  const task = (async () => {
    try {
      const vector = await requestEmbedding(text, settings);
      cache.set(key, vector);
      if (cache.size > 100) cache.delete(cache.keys().next().value!);
      return vector as number[];
    } catch {
      failed.set(key, Date.now() + 60_000);
      if (failed.size > 100) failed.delete(failed.keys().next().value!);
      return [];
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, task);
  return task;
}
