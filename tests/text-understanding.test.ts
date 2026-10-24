import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeTextWithLlm } from '@/core/understanding/text-llm';
import { DEFAULT_SETTINGS } from '@/core/db/settings.repo';
import { embedAtmosphere } from '@/core/llm/embedding';
const settings = { ...DEFAULT_SETTINGS, llm_endpoint: 'https://example.test/v1', llm_key: 'test' };
afterEach(() => vi.unstubAllGlobals());
const valid = { emotion: [.1, 0, .3, .1, 0, 0, 0, 0], scene_tags: ['平静舒缓'], confidence: .8 };
describe('bounded text understanding calls', () => {
  it('retries the same window immediately after correcting a rejected credential', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if ((init.headers as Record<string, string>).Authorization === 'Bearer bad')
        return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(valid) } }] }) };
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(analyzeTextWithLlm('固定阅读片段', 'credential-change', { ...settings, llm_key: 'bad' })).rejects.toThrow('401');
    expect(await analyzeTextWithLlm('固定阅读片段', 'credential-change', { ...settings, llm_key: 'corrected' })).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not reuse embedding failure backoff across credentials', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if ((init.headers as Record<string, string>).Authorization === 'Bearer bad')
        return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: [{ embedding: [.1, .2] }] }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const config = { ...settings, embedding_model: 'test-rekey' };
    expect(await embedAtmosphere('平静湖面', { ...config, llm_key: 'bad' })).toEqual([]);
    expect(await embedAtmosphere('平静湖面', { ...config, llm_key: 'corrected' })).toEqual([.1, .2]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('shares concurrent requests and caches the same reading window', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify(valid) } }],
    }) }));
    vi.stubGlobal('fetch', fetcher);
    const [a, b] = await Promise.all([
      analyzeTextWithLlm('一段安静的文字', 'concurrent', settings),
      analyzeTextWithLlm('一段安静的文字', 'concurrent', settings),
    ]);
    expect(a).toEqual(b);
    await analyzeTextWithLlm('一段安静的文字', 'concurrent', settings);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('backs off after an invalid taxonomy response', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ ...valid, scene_tags: ['not-a-tag'] }) } }],
    }) }));
    vi.stubGlobal('fetch', fetcher);
    await expect(analyzeTextWithLlm('内容', 'invalid', settings)).rejects.toThrow('八维');
    await expect(analyzeTextWithLlm('内容', 'invalid', settings)).rejects.toThrow('八维');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('accepts Qwen streamed content directly without requiring JSON-mode support or mixing dictionary scores', async () => {
    const vector = [.91, .12, .23, .34, .45, .56, .67, .78];
    const fetcher = vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"忽略推理内容"}}]}',
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ emotion: vector, confidence: .9,
        evidence: '反讽语境中仍透出喜悦' }) }, finish_reason: 'stop' }] })}`,
      'data: [DONE]',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await analyzeTextWithLlm('悲伤！悲伤！', 'qwen-stream-direct', { ...settings, llm_model: 'qwen3.8-omni-flash' });
    expect(result?.emotion).toEqual(vector);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ stream: true, model: 'qwen3.8-omni-flash' });
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('temperature');
  });
});
