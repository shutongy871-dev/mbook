import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnoseLlm } from '@/core/llm/diagnostics';
import { requestEmbedding } from '@/core/llm/embedding';
import { DEFAULT_SETTINGS } from '@/core/db/settings.repo';
const config = { ...DEFAULT_SETTINGS, llm_endpoint: 'https://test.invalid/v1', llm_key: 'private-test-key', embedding_model: 'embed' };
afterEach(() => vi.unstubAllGlobals());
describe('BYOK connection diagnostics', () => {
  it('checks the production emotion schema and vector without reporting secrets', async () => {
    const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/embeddings') ?
      { data: [{ embedding: [.1, .2, -.3] }] } : { choices: [{ message: { content: JSON.stringify({
        emotion: [.1, 0, .3, .1, 0, 0, 0, 0], scene_tags: ['平静舒缓'], confidence: .8,
      }) } }] } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await diagnoseLlm(config);
    expect(result.map(r => r.ok)).toEqual([true, true]);
    expect(result[1]?.message).toContain('3 维');
    expect(JSON.stringify(result)).not.toContain(config.llm_key);
    await diagnoseLlm(config);
    expect(fetcher).toHaveBeenCalledTimes(4); // diagnostics must make new network requests
  });
  it('does not read or echo an error body that reflects the API key', async () => {
    const body = vi.fn(async () => config.llm_key);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: body })));
    const checks = await diagnoseLlm(config);
    expect(checks.every(c => !c.ok && c.message === 'LLM HTTP 401')).toBe(true);
    expect(body).not.toHaveBeenCalled();
  });
  it('rejects a zero vector and invalid tags instead of calling them compatible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [0, 0] }] }) })));
    await expect(requestEmbedding('安静', config)).rejects.toThrow('invalid embedding');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
      choices: [{ message: { content: '{"emotion":[0,0,0,0,0,0,0,0],"scene_tags":["invented"],"confidence":1}' } }],
    }) })));
    expect((await diagnoseLlm({ ...config, embedding_model: '' }))[0]?.ok).toBe(false);
  });
});
