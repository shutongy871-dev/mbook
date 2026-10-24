import { browser } from 'wxt/browser';
import { audioEngine } from '@/core/playback/audio-engine';
import { logger } from '@/core/shared/logger';
import type { OffscreenCommand } from '@/core/shared/contracts';
import { runAudioWork, cancelAudioWork } from '@/core/understanding/audio-tag-worker';

// 播放与听感画像各自执行；采样不会发出声音。
logger.info('offscreen 启动');

browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if ('type' in msg && msg.type === 'OFFSCREEN_AUDIO_WORK') {
    void runAudioWork().catch(() => logger.warn('[audio-tag] 任务调度失败，将在下次唤醒检查租约'));
    sendResponse({ ok: true });
    return;
  }
  if ('type' in msg && msg.type === 'OFFSCREEN_AUDIO_CANCEL') {
    cancelAudioWork();
    sendResponse({ ok: true });
    return;
  }
  const cmd = msg as OffscreenCommand;
  let response: unknown;
  switch (cmd.type) {
    case 'OFFSCREEN_PLAY':
      if (cmd.url && cmd.trackId && cmd.title) {
        response = audioEngine.play(
          cmd.url,
          cmd.trackId,
          cmd.title,
          cmd.volume ?? 40,
          cmd,
        );
      }
      break;
    case 'OFFSCREEN_PAUSE':
      response = audioEngine.pause();
      break;
    case 'OFFSCREEN_RESUME':
      response = audioEngine.resume();
      break;
    case 'OFFSCREEN_SET_VOLUME':
      if (typeof cmd.volume === 'number') response = audioEngine.setVolume(cmd.volume);
      break;
    case 'OFFSCREEN_PRELOAD':
      audioEngine.preload(cmd.url);
      break;
    case 'OFFSCREEN_GET_STATE':
      // 同步返回当前播放态，供 SW 休眠唤醒后核对
      response = audioEngine.getState();
      break;
  }
  if (response === undefined) return;
  // Chrome requires sendResponse for synchronous values; returning an object is ignored.
  Promise.resolve(response).then(sendResponse, error => sendResponse({
    ok: false, state: audioEngine.getState(), error: String(error),
  }));
  return true;
});
