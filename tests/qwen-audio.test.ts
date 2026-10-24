import { describe, expect, it, vi, afterEach } from 'vitest';
import { audioEndpoint, parseAudioEmotion, readAudioStream, recognizeAudio } from '@/core/llm/qwen-audio';
import { sampleWindows, encodeWav } from '@/core/understanding/audio-sample';
import { DEFAULT_SETTINGS } from '@/core/db/settings.repo';

const vector = [.1, .2, .8, .3, 0, 0, .1, 0];
const windows = sampleWindows(120);
const json = (emotions: Array<number[] | null>) => JSON.stringify({ segments: emotions.map((emotion, index) => ({
  index, emotion, evidence: '柔和旋律与舒缓节奏', confidence: .8,
})) });
function stream(parts: unknown[], done = true) {
  const content = parts.map(p => `data: ${JSON.stringify(p)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(content);
  return new Response(new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); },
  }));
}
afterEach(() => vi.unstubAllGlobals());
describe('Qwen audio spike: sampling, streaming and eight independent intensities', () => {
  it('samples non-overlapping front/middle/end windows and produces 16k mono PCM WAV', () => {
    expect(windows.map(w => w.start_sec)).toEqual([0, 50, 100]);
    expect(sampleWindows(9).map(w => w.start_sec)).toEqual([0, 3, 6]);
    expect(() => sampleWindows(601)).toThrow();
    const wav = encodeWav(new Float32Array([-1, 0, 1]));
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect([44, 46, 48].map(i => view.getInt16(i, true))).toEqual([-32768, 0, 32767]);
  });
  it('duration-weights known segments; unknown is not a zero vector', () => {
    const result = parseAudioEmotion(json([vector, null, vector.map(n => n / 2)]), windows);
    expect(result.coverage).toBeCloseTo(2 / 3);
    expect(result.emotion?.[2]).toBeCloseTo(.6);
    expect(result.segments[1]?.emotion).toBeNull();
    expect(parseAudioEmotion(json([null, null, null]), windows).emotion).toBeNull();
    expect(parseAudioEmotion(json([Array(8).fill(0), null, null]), windows).emotion).toEqual(Array(8).fill(0));
    const unequal = windows.map((w, i) => ({ ...w, duration_sec: i === 0 ? 10 : 20 }));
    expect(parseAudioEmotion(json([vector, null, vector.map(n => n / 2)]), unequal).emotion?.[2]).toBeCloseTo(.5333333);
  });
  it('rejects missing, repeated, nonnumeric and out-of-range dimensions', () => {
    expect(() => parseAudioEmotion(json([vector]), windows)).toThrow();
    expect(() => parseAudioEmotion(json([vector, vector.slice(1), vector]), windows)).toThrow();
    expect(() => parseAudioEmotion(json([vector, Array(8).fill(1.1), vector]), windows)).toThrow();
    const duplicate = JSON.parse(json([vector, vector, vector]));
    duplicate.segments[2].index = 0;
    expect(() => parseAudioEmotion(JSON.stringify(duplicate), windows)).toThrow();
  });
  it('handles UTF-8 boundaries, ignores reasoning and records actual usage', async () => {
    const text = json([vector, null, vector]);
    const response = stream([
      { choices: [{ delta: { reasoning_content: 'this is not JSON' } }] },
      { choices: [{ delta: { content: text.slice(0, 50) } }] },
      { choices: [{ delta: { content: text.slice(50) }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 500, completion_tokens: 160,
        prompt_tokens_details: { audio_tokens: 420, text_tokens: 80 } } },
    ]);
    expect(await readAudioStream(response)).toEqual({ text,
      usage: { input_tokens: 500, output_tokens: 160, audio_tokens: 420, text_tokens: 80 } });
    await expect(readAudioStream(stream([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }], false))).rejects.toThrow();
    await expect(readAudioStream(stream([{ choices: [{ finish_reason: 'length' }] }]))).rejects.toThrow();
    await expect(readAudioStream(stream([{ error: { code: 'InternalError' } }]))).rejects.toThrow();
  });
  it('posts actual input_audio through the independent config, marks auth/rate errors as halt', async () => {
    const settings = { ...DEFAULT_SETTINGS, song_audio_endpoint: 'https://example.test/compatible-mode/v1/',
      song_audio_key: 'test-only', llm_key: 'text-key-not-used' };
    expect(audioEndpoint(settings)).toBe('https://example.test/compatible-mode/v1/chat/completions');
    const fetcher = vi.fn(async () => stream([{ choices: [{ delta: { content: json([vector, vector, vector]) }, finish_reason: 'stop' }] }]));
    vi.stubGlobal('fetch', fetcher);
    const sample = { data: 'data:audio/wav;base64,UklGRg==', segments: windows };
    const result = await recognizeAudio(settings, sample, new AbortController().signal);
    expect(result.emotion).toEqual(vector);
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].headers).toMatchObject({ Authorization: 'Bearer test-only' });
    const body = JSON.parse(call[1].body as string);
    expect(body).toMatchObject({ model: 'qwen3.8-omni-flash', stream: true });
    expect(body.messages[1].content[0]).toEqual({ type: 'input_audio', input_audio: { data: sample.data, format: 'wav' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret provider error', { status: 401 })));
    await expect(recognizeAudio(settings, sample, new AbortController().signal)).rejects.toMatchObject({ halt: true });
  });
});
