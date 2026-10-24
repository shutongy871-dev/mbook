import type { AudioSegment } from '@/core/shared/contracts';

const RATE = 16000;
const MAX_BYTES = 32 * 1024 * 1024;

export function sampleWindows(duration: number): AudioSegment[] {
  if (!Number.isFinite(duration) || duration < 3 || duration > 600)
    throw new Error('音频时长需在 3～600 秒之间');
  const size = Math.min(20, duration / 3);
  return [0, (duration - size) / 2, duration - size].map((start, index) => ({
    index, start_sec: start, duration_sec: size, input_start_sec: index * size,
  }));
}

export function encodeWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2,
    Math.round(Math.max(-1, Math.min(1, s)) * (s < 0 ? 32768 : 32767)), true));
  return bytes;
}

async function download(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error(`音频下载失败（HTTP ${response.status}）`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('音频超过 32 MB 上限');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) throw new Error('音频超过 32 MB 上限');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}

// 独立离线解码/重采样，不连接扬声器，不改变正在播放的 AudioContext。
export async function prepareAudioSample(url: string, signal: AbortSignal,
  expectedDuration?: number): Promise<{ data: string; segments: AudioSegment[] }> {
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let bytes: ArrayBuffer;
  try { bytes = await download(url, downloadSignal); }
  catch (error) {
    if (signal.aborted) throw error;
    if (downloadSignal.aborted) throw new Error('音频下载超时（30 秒）');
    if (error instanceof Error && error.message.startsWith('音频')) throw error;
    throw new Error('音频下载网络失败，请检查音源地址、网络与访问权限');
  }
  signal.throwIfAborted();
  const decoder = new OfflineAudioContext(1, 1, RATE);
  let decoded: AudioBuffer;
  try { decoded = await decoder.decodeAudioData(bytes); }
  catch { throw new Error('音频解码失败，浏览器不支持该格式或音频文件损坏'); }
  signal.throwIfAborted();
  if (expectedDuration && decoded.duration < expectedDuration * .8)
    throw new Error('下载音频疑似试听片段，不足原曲时长的 80%');
  const segments = sampleWindows(decoded.duration);
  const totalSamples = Math.round(segments.reduce((sum, s) => sum + s.duration_sec, 0) * RATE);
  const render = new OfflineAudioContext(1, totalSamples, RATE);
  for (const segment of segments) {
    const source = render.createBufferSource();
    source.buffer = decoded;
    source.connect(render.destination);
    source.start(segment.input_start_sec, segment.start_sec, segment.duration_sec);
  }
  const output = await render.startRendering();
  signal.throwIfAborted();
  const wav = encodeWav(output.getChannelData(0));
  let binary = '';
  for (let i = 0; i < wav.length; i += 8192)
    binary += String.fromCharCode(...wav.subarray(i, i + 8192));
  return { data: `data:audio/wav;base64,${btoa(binary)}`, segments };
}
