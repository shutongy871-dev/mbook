import { AudioEngine } from '../core/playback/audio-engine';
const engine = new AudioEngine();
const result = document.querySelector('pre')!;
const origin = new URL(location.href).searchParams.get('origin')!;
const playingEvents = new Map<string, number>();
// AudioEngine's elements are detached, so observe their real media events at construction.
const NativeAudio = globalThis.Audio;
globalThis.Audio = class extends NativeAudio {
  constructor() {
    super();
    this.addEventListener('playing', () => playingEvents.set(new URL(this.src).pathname.slice(1), performance.now()));
  }
};
for (const button of document.querySelectorAll('button')) button.addEventListener('click', async () => {
  const mode = button.dataset.mode!;
  if (mode === 'pause') {
    document.querySelector('#pause-result')!.textContent = JSON.stringify(await engine.pause());
    return;
  }
  const started = performance.now();
  const reply = await engine.play(`${origin}/${mode}`, mode, mode, 20);
  const mediaStarted = playingEvents.get(mode);
  result.textContent = JSON.stringify({ ...reply, elapsed: performance.now() - started,
    media_start_ms: mediaStarted != null && mediaStarted >= started ? mediaStarted - started : null });
});
setInterval(() => {
  document.querySelector('output')!.textContent = JSON.stringify(engine.getState());
}, 250);
