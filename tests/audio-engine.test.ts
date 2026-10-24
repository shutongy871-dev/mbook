import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: vi.fn(async () => {}) } } }));
import { AudioEngine, equalPowerCurve } from '@/core/playback/audio-engine';

const audios: FakeAudio[] = [];
let mode: 'success' | 'fail' | 'hang' | 'cors' = 'success';
class FakeAudio {
  src = '';
  crossOrigin = '';
  preload = '';
  currentTime = 0;
  ended = false;
  paused = true;
  volume = 1;
  handlers = new Map<string, () => void>();
  constructor() { audios.push(this); }
  async play() {
    if (mode === 'cors' && this.crossOrigin === 'anonymous') throw new DOMException('CORS', 'NotSupportedError');
    if (mode === 'fail') throw new Error('network');
    if (mode === 'hang') return new Promise<void>(() => {});
    this.paused = false;
  }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() { this.src = ''; }
  addEventListener(event: string, cb: () => void) { this.handlers.set(event, cb); }
}
const gains: ReturnType<typeof gainNode>[] = [];
function gainNode() {
  return { gain: { value: 0, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(), setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
}
class FakeContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  createMediaElementSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  createGain() { const g = gainNode(); gains.push(g); return g; }
  async resume() {}
}
beforeEach(() => {
  mode = 'success'; audios.length = 0; gains.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('AudioContext', FakeContext);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('real playback acknowledgement', () => {
  it('never starts an expired track after a delayed AudioContext resume', async () => {
    let release!: () => void;
    const play = vi.spyOn(FakeAudio.prototype, 'play');
    class SuspendedContext extends FakeContext {
      override state = 'suspended';
      override resume() { return new Promise<void>(resolve => { release = resolve; }); }
    }
    vi.stubGlobal('AudioContext', SuspendedContext);
    const engine = new AudioEngine();
    const pending = engine.play('/slow-context', 'slow', 'Slow', 40);
    await vi.advanceTimersByTimeAsync(3001);
    expect((await pending).ok).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(play).not.toHaveBeenCalled();
    play.mockRestore();
  });
  it('a pause cancels pending startup immediately and prevents a late play', async () => {
    let release!: () => void;
    class SuspendedContext extends FakeContext {
      override state = 'suspended';
      override resume() { return new Promise<void>(resolve => { release = resolve; }); }
    }
    vi.stubGlobal('AudioContext', SuspendedContext);
    const engine = new AudioEngine();
    const pending = engine.play('/slow', 'slow', 'Slow', 40);
    await engine.pause();
    expect((await pending).ok).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(audios[0]?.paused).toBe(true);
    expect(engine.getState().status).toBe('stopped');
  });
  it('shares the three-second budget between CORS failure and native retry', async () => {
    const play = vi.spyOn(FakeAudio.prototype, 'play').mockImplementation(async function (this: FakeAudio) {
      if (this.crossOrigin) {
        await new Promise(resolve => setTimeout(resolve, 2500));
        throw new DOMException('CORS', 'NotSupportedError');
      }
      return new Promise<void>(() => {});
    });
    const engine = new AudioEngine();
    const pending = engine.play('https://cdn.example/slow', 'slow', 'Slow', 40);
    await vi.advanceTimersByTimeAsync(3001);
    expect((await pending).ok).toBe(false);
    expect(audios).toHaveLength(2);
    expect(audios.every(audio => audio.paused && !audio.src)).toBe(true);
    play.mockRestore();
  });
  it('keeps the old track and its envelope untouched when the new track fails', async () => {
    const engine = new AudioEngine();
    expect((await engine.play('/a', 'a', 'A', 40)).ok).toBe(true);
    const curvesBefore = gains[0]!.gain.setValueCurveAtTime.mock.calls.length;
    mode = 'fail';
    const failed = await engine.play('/b', 'b', 'B', 40);
    expect(failed.ok).toBe(false);
    expect(failed.state.trackId).toBe('a');
    expect(failed.state.status).toBe('playing');
    expect(failed.state.blocked).toBe(false);
    expect(audios[0]!.paused).toBe(false);
    expect(gains[0]!.gain.setValueCurveAtTime.mock.calls.length).toBe(curvesBefore);
    expect(audios[1]!.src).toBe('');
  });
  it('acknowledges a three second start timeout and tears down the hung audio', async () => {
    const engine = new AudioEngine();
    mode = 'hang';
    const pending = engine.play('/hang', 'h', 'H', 40);
    await vi.advanceTimersByTimeAsync(3001);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.state.status).toBe('stopped');
    expect(audios[0]!.paused).toBe(true);
    expect(audios[0]!.src).toBe('');
  });
  it('honors the shared foreground deadline rather than adding a fresh three seconds', async () => {
    const engine = new AudioEngine();
    await engine.play('/old', 'old', 'Old', 40);
    mode = 'hang';
    const pending = engine.play('/hang', 'h', 'H', 40, { startDeadline: Date.now() + 1500 });
    await vi.advanceTimersByTimeAsync(1501);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.state).toMatchObject({ trackId: 'old', status: 'playing' });
    expect(audios[1]!.paused).toBe(true);
    expect(audios[1]!.src).toBe('');
  });
  it('pauses all overlapping audio, then resumes with the persisted position', async () => {
    const engine = new AudioEngine();
    await engine.play('/a', 'a', 'A', 40);
    await engine.play('/b', 'b', 'B', 40, { fadeInMs: 500, fadeOutMs: 2500 });
    audios[1]!.currentTime = 17;
    const paused = engine.pause();
    await vi.advanceTimersByTimeAsync(180);
    expect((await paused).state.status).toBe('paused');
    expect(audios.every(a => a.paused)).toBe(true);
    expect((await engine.resume()).state.positionSec).toBe(17);
  });
  it('sets anonymous CORS and accepts configured envelopes', async () => {
    const engine = new AudioEngine();
    await engine.play('/a', 'a', 'A', 70, { fadeInMs: 750 });
    expect(audios[0]!.crossOrigin).toBe('anonymous');
    expect(gains[0]!.gain.setValueCurveAtTime.mock.calls[0]?.[2]).toBe(.75);
  });
  it('equal power keeps sum of squared amplitudes constant', () => {
    const incoming = equalPowerCurve(.4, true), outgoing = equalPowerCurve(.4, false);
    for (let i = 0; i < incoming.length; i++)
      expect(incoming[i]! ** 2 + outgoing[i]! ** 2).toBeCloseTo(.16, 6);
  });
  it('falls back to a fresh native element when remote CORS rejects Web Audio', async () => {
    const engine = new AudioEngine();
    mode = 'cors';
    const result = await engine.play('https://cdn.example/music.mp3', 'cors', 'Remote', 40);
    expect(result.ok).toBe(true);
    expect(audios).toHaveLength(2);
    expect(audios[0]!.src).toBe('');
    expect(audios[1]!.crossOrigin).toBe('');
    await vi.advanceTimersByTimeAsync(1500);
    expect(audios[1]!.volume).toBeCloseTo(.4);
    const paused = engine.pause();
    await vi.advanceTimersByTimeAsync(180);
    expect((await paused).state.status).toBe('paused');
    expect(audios[1]!.paused).toBe(true);
    await engine.resume();
    expect(audios[1]!.volume).toBeCloseTo(.4);
  });
});
