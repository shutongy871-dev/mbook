import type { SongProfile } from '@/core/shared/contracts';

export type AudioFeatures = NonNullable<SongProfile['audio_features']>;

export function spectralCentroid(dbBins: Float32Array, sampleRate: number, fftSize: number): number | undefined {
  let mass = 0, weighted = 0;
  for (let i = 1; i < dbBins.length; i++) {
    const amplitude = Number.isFinite(dbBins[i]) ? 10 ** (dbBins[i]! / 20) : 0;
    mass += amplitude;
    weighted += amplitude * i * sampleRate / fftSize;
  }
  return mass > 1e-8 ? weighted / mass : undefined;
}

// RMS onset-envelope autocorrelation; low-confidence tempo stays unknown (0).
export function summarizeAudio(rms: number[], sampleRate = 20): AudioFeatures | null {
  if (rms.length < sampleRate * 5 || Math.max(...rms) < 1e-5) return null;
  const onset = rms.map((v, i) => Math.max(0, v - (rms[i - 1] ?? v)));
  const mean = onset.reduce((a, b) => a + b, 0) / onset.length;
  const centered = onset.map(x => x - mean);
  let best = 0, lagAt = 0;
  for (let lag = Math.ceil(60 * sampleRate / 180); lag <= Math.floor(60 * sampleRate / 45); lag++) {
    let cross = 0, energy1 = 0, energy2 = 0;
    for (let i = lag; i < centered.length; i++) {
      cross += centered[i]! * centered[i - lag]!;
      energy1 += centered[i]! ** 2; energy2 += centered[i - lag]! ** 2;
    }
    const score = cross / Math.sqrt(energy1 * energy2 || 1);
    if (score > best) { best = score; lagAt = lag; }
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * .1)] ?? 0;
  const high = sorted[Math.floor(sorted.length * .9)] ?? 0;
  const energy_curve: number[] = [];
  for (let i = 0; i < rms.length; i += sampleRate * 5) {
    const window = rms.slice(i, i + sampleRate * 5);
    energy_curve.push(window.reduce((a, b) => a + b, 0) / window.length);
  }
  return { bpm: best > .3 ? Math.round(60 * sampleRate / lagAt) : 0,
    vocal_density: null, dynamic_range: high ? Math.min(1, (high - low) / high) : 0, energy_curve };
}

// Observes only the first 30 seconds of actual playback, never fetches/stores audio files.
export function observeAudio(ctx: AudioContext, source: MediaElementAudioSourceNode,
  audio: HTMLAudioElement, done: (features: AudioFeatures | null) => void): () => void {
  if (typeof ctx.createAnalyser !== 'function') return () => {};
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  const frequency = new Float32Array(analyser.frequencyBinCount);
  const centroids: number[] = [];
  const samples: number[] = [];
  let finished = false;
  const stop = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    try { source.disconnect(analyser); analyser.disconnect(); } catch { /* already released */ }
    if (samples.length >= 100) {
      const features = summarizeAudio(samples);
      if (features && centroids.length)
        features.spectral_centroid_hz = centroids.reduce((s, v) => s + v, 0) / centroids.length;
      done(features);
    }
  };
  const timer = setInterval(() => {
    if (audio.ended || audio.currentTime >= 30 || samples.length >= 600) { stop(); return; }
    if (audio.paused) return;
    analyser.getFloatTimeDomainData(data);
    samples.push(Math.sqrt(data.reduce((n, x) => n + x * x, 0) / data.length));
    // 1Hz 足够做音色代理，避免每50ms执行额外 FFT 数据处理。
    if (samples.length % 20 === 0) {
      analyser.getFloatFrequencyData(frequency);
      const centroid = spectralCentroid(frequency, ctx.sampleRate, analyser.fftSize);
      if (centroid != null) centroids.push(centroid);
    }
  }, 50);
  return stop;
}
