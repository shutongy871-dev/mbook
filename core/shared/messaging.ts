import { browser } from 'wxt/browser';
import type {
  BackgroundMessage,
  OffscreenCommand,
  OffscreenStateMessage,
  StatusResponse,
} from './contracts';

export async function sendToBackground(
  msg: BackgroundMessage,
): Promise<StatusResponse | undefined> {
  return (await browser.runtime.sendMessage(msg)) as StatusResponse | undefined;
}

export async function sendOffscreenCommand(cmd: OffscreenCommand): Promise<void> {
  await browser.runtime.sendMessage(cmd);
}

// 订阅 offscreen 广播的播放状态，返回取消订阅函数
export function onPlaybackState(
  handler: (msg: OffscreenStateMessage) => void,
): () => void {
  const listener = (msg: unknown) => {
    if (
      msg &&
      typeof msg === 'object' &&
      (msg as { type?: string }).type === 'OFFSCREEN_STATE'
    ) {
      handler(msg as OffscreenStateMessage);
    }
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
