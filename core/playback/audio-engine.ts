import { browser } from 'wxt/browser';
import type { PlaybackResult, PlaybackState } from '@/core/shared/contracts';
import { observeAudio } from './audio-analysis';

interface ActiveTrack {
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode | null;
  gain: GainNode | null;
  stopAnalysis?: () => void;
  stopEnvelope?: () => void;
}

export function equalPowerCurve(volume: number, incoming: boolean): Float32Array {
  return Float32Array.from({ length: 64 }, (_, i) =>
    volume * (incoming ? Math.sin(i / 63 * Math.PI / 2) : Math.cos(i / 63 * Math.PI / 2)));
}

const clampVolume = (v: number) => Math.max(0, Math.min(1, v / 100));
const fadeDuration = (ms = 1500) => Math.max(0.05, Math.min(3000, ms) / 1000);

// Offscreen owns the playback truth. All mutations return an acknowledged result.
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private current: ActiveTrack | null = null;
  private preloaded: HTMLAudioElement | null = null;
  private preloadedAt = 0;
  private retiring = new Set<ActiveTrack>();
  private volume = 0.4;
  private generation = 0;
  private pendingStart: AbortController | null = null;
  private state: PlaybackState = { status: 'stopped', trackId: null, title: null, volume: 40 };

  getState(): PlaybackState {
    return { ...this.state, volume: Math.round(this.volume * 100),
      positionSec: this.current?.audio.currentTime ?? 0 };
  }

  private result(ok: boolean, error?: unknown): PlaybackResult {
    const message = error instanceof Error ? error.message : error ? String(error) : undefined;
    this.state.error = message;
    const state = this.getState();
    void browser.runtime.sendMessage({ type: 'OFFSCREEN_STATE', state }).catch(() => {});
    return { ok, state, error: message };
  }

  private createAudio(url: string, direct = false): HTMLAudioElement {
    const audio = new Audio();
    // Must be set BEFORE src or MediaElementSource can silently output zeroes.
    if (!direct) audio.crossOrigin = 'anonymous';
    else audio.volume = 0;
    audio.preload = 'auto';
    audio.src = url;
    return audio;
  }

  preload(url: string): void {
    if (this.preloaded?.src === url) return;
    if (this.preloaded) this.preloaded.src = '';
    this.preloaded = this.createAudio(url);
    this.preloadedAt = Date.now();
    this.preloaded.load();
    const audio = this.preloaded;
    setTimeout(() => {
      if (this.preloaded !== audio) return;
      audio.removeAttribute('src'); audio.load(); this.preloaded = null;
    }, 60_000);
  }

  private async start(audio: HTMLAudioElement, direct = false, deadline = Date.now() + 3000): Promise<void> {
    this.pendingStart?.abort();
    const controller = new AbortController();
    this.pendingStart = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cancelled = () => audio.pause();
    controller.signal.addEventListener('abort', cancelled, { once: true });
    try {
      if (Date.now() >= deadline) throw new Error('起播超时');
      await Promise.race([
        (async () => {
          if (!direct && this.ctx?.state === 'suspended') await this.ctx.resume();
          controller.signal.throwIfAborted();
          await audio.play();
          controller.signal.throwIfAborted();
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('起播超时'));
            controller.abort();
          }, Math.max(0, deadline - Date.now()));
          controller.signal.addEventListener('abort', () => reject(new Error('播放请求已取消')), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', cancelled);
      if (this.pendingStart === controller) this.pendingStart = null;
    }
  }

  async play(url: string, trackId: string, title: string, volumePct: number,
    options: { fadeInMs?: number; fadeOutMs?: number; hardCut?: boolean; direct?: boolean; positionSec?: number; startDeadline?: number } = {},
  ): Promise<PlaybackResult> {
    if (this.current && this.state.trackId === trackId && this.state.status !== 'stopped' && !this.current.audio.ended) {
      this.setVolume(volumePct);
      return this.resume();
    }
    this.pendingStart?.abort();
    const generation = ++this.generation;
    const startDeadline = options.startDeadline ?? Date.now() + 3000;
    this.ctx ??= new AudioContext();
    const ctx = this.ctx;
    const audio = !options.direct && this.preloaded?.src === url && Date.now() - this.preloadedAt < 60_000 ? this.preloaded : this.createAudio(url, options.direct);
    if (audio === this.preloaded) this.preloaded = null;
    const source = options.direct ? null : ctx.createMediaElementSource(audio);
    const gain = options.direct ? null : ctx.createGain();
    if (gain && source) {
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(ctx.destination);
    }
    const next: ActiveTrack = { audio, source, gain };
    if (options.positionSec && options.positionSec > 0) {
      const seek = () => {
        audio.currentTime = Math.min(options.positionSec!, Number.isFinite(audio.duration) ? Math.max(0, audio.duration - .25) : options.positionSec!);
      };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    try {
      await this.start(audio, options.direct, startDeadline);
      if (generation !== this.generation) {
        this.teardown(next);
        return this.result(false, '播放请求已取消');
      }
    } catch (error) {
      this.teardown(next);
      if (generation !== this.generation) return { ok: false, state: this.getState(), error: '播放请求已取消' };
      // A fresh native element can play a server stream without Web Audio/CORS.
      // Never retry an autoplay denial or a timeout; preserve the existing track.
      if (!options.direct && generation === this.generation && /^https?:/.test(url) &&
        error instanceof DOMException && error.name === 'NotSupportedError') {
        return this.play(url, trackId, title, volumePct, { ...options, direct: true, startDeadline });
      }
      this.state.blocked = error instanceof DOMException && error.name === 'NotAllowedError';
      // No state or envelope change to the old track on a failed replacement.
      return this.result(false, error);
    }

    const old = this.current;
    this.volume = clampVolume(volumePct);
    this.current = next;
    this.state = { status: 'playing', trackId, title, volume: volumePct, blocked: false };
    if (source) next.stopAnalysis = observeAudio(ctx, source, audio, features => {
      void browser.runtime.sendMessage({ type: 'OFFSCREEN_AUDIO_FEATURES', trackId, features }).catch(() => {});
    });
    else void browser.runtime.sendMessage({ type: 'OFFSCREEN_AUDIO_FEATURES', trackId, features: null }).catch(() => {});
    const remaining = old && Number.isFinite(old.audio.duration) ?
      Math.max(.05, old.audio.duration - old.audio.currentTime) : Infinity;
    const fadeIn = Math.min(fadeDuration(options.fadeInMs), remaining);
    const fadeOut = Math.min(fadeDuration(options.fadeOutMs), remaining);
    if (options.hardCut) {
      this.teardown(old);
      this.level(next, this.volume);
    } else {
      this.envelope(next, this.volume, true, fadeIn);
      if (old) {
        const oldVolume = old.gain?.gain.value ?? old.audio.volume;
        this.envelope(old, oldVolume, false, fadeOut);
        this.retiring.add(old);
        setTimeout(() => this.teardown(old), fadeOut * 1000 + 50);
      }
    }
    audio.addEventListener('ended', () => {
      if (this.current !== next) return;
      this.state.status = 'stopped';
      this.result(true);
      void browser.runtime.sendMessage({ type: 'OFFSCREEN_ENDED', trackId, title }).catch(() => {});
    });
    audio.addEventListener('error', () => {
      if (this.current !== next) return;
      this.state.status = 'stopped';
      this.result(false, '音频加载中断');
      void browser.runtime.sendMessage({ type: 'OFFSCREEN_FAILED', trackId }).catch(() => {});
    });
    return this.result(true);
  }

  async pause(): Promise<PlaybackResult> {
    const generation = ++this.generation; // Also cancels pending starts.
    this.pendingStart?.abort();
    for (const track of this.retiring) this.teardown(track);
    const current = this.current;
    if (!current || !this.ctx || this.state.status !== 'playing') return this.result(true);
    current.stopEnvelope?.();
    if (current.gain) {
      current.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      current.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
    } else this.envelope(current, current.audio.volume, false, .18);
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    if (generation !== this.generation) return this.result(false, '暂停请求已取消');
    current.audio.pause();
    this.state.status = 'paused';
    return this.result(true);
  }

  async resume(): Promise<PlaybackResult> {
    if (!this.current || !this.ctx) return this.result(false, '没有可恢复的曲目');
    const generation = ++this.generation;
    const current = this.current;
    try {
      await this.start(current.audio, !current.source);
      if (generation !== this.generation) return { ok: false, state: this.getState(), error: '播放请求已取消' };
      this.level(current, this.volume);
      this.state.status = 'playing';
      this.state.blocked = false;
      return this.result(true);
    } catch (error) {
      if (generation !== this.generation) return { ok: false, state: this.getState(), error: '播放请求已取消' };
      current.audio.pause();
      this.state.blocked = error instanceof DOMException && error.name === 'NotAllowedError';
      return this.result(false, error);
    }
  }

  setVolume(volumePct: number): PlaybackResult {
    this.volume = clampVolume(volumePct);
    if (this.ctx && this.current && this.state.status === 'playing') {
      this.level(this.current, this.volume);
    }
    return this.result(true);
  }

  private level(track: ActiveTrack, value: number): void {
    track.stopEnvelope?.();
    if (track.gain && this.ctx) {
      track.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      track.gain.gain.setTargetAtTime(value, this.ctx.currentTime, .05);
    } else track.audio.volume = Math.max(0, Math.min(1, value));
  }

  private envelope(track: ActiveTrack, volume: number, incoming: boolean, duration: number): void {
    track.stopEnvelope?.();
    if (track.gain && this.ctx) {
      track.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      track.gain.gain.setValueCurveAtTime(equalPowerCurve(volume, incoming), this.ctx.currentTime, duration);
      return;
    }
    const start = Date.now();
    const update = () => {
      const p = Math.min(1, (Date.now() - start) / (duration * 1000));
      track.audio.volume = Math.max(0, Math.min(1, volume * (incoming ? Math.sin(p * Math.PI / 2) : Math.cos(p * Math.PI / 2))));
      if (p >= 1) track.stopEnvelope?.();
    };
    track.stopEnvelope = () => clearInterval(timer);
    const timer = setInterval(update, 20);
    update();
  }

  private teardown(track: ActiveTrack | null): void {
    if (!track) return;
    track.stopAnalysis?.();
    track.stopEnvelope?.();
    this.retiring.delete(track);
    track.audio.pause();
    track.audio.removeAttribute('src');
    track.audio.load();
    track.source?.disconnect();
    track.gain?.disconnect();
  }
}

export const audioEngine = new AudioEngine();
