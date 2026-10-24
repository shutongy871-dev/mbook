import { browser } from 'wxt/browser';
import { logger } from '@/core/shared/logger';
import type { PlaybackResult, PlaybackState } from '@/core/shared/contracts';

// Service Worker 侧：管理 offscreen document 生命周期并向其下发播放指令
// chrome.offscreen 的类型不在 webextension polyfill 中，这里做最小化封装

interface OffscreenApi {
  hasDocument?: () => Promise<boolean>;
  createDocument: (options: {
    url: string;
    reasons: string[];
    justification: string;
  }) => Promise<void>;
}

function getOffscreenApi(): OffscreenApi | null {
  const api = (globalThis as { chrome?: { offscreen?: OffscreenApi } }).chrome
    ?.offscreen;
  return api ?? null;
}

let creating: Promise<boolean> | null = null;
export async function ensureOffscreenDocument(): Promise<boolean> {
  if (creating) return creating;
  creating = createOffscreenDocument();
  try { return await creating; } finally { creating = null; }
}

async function createOffscreenDocument(): Promise<boolean> {
  const api = getOffscreenApi();
  if (!api) {
    logger.warn('当前浏览器不支持 offscreen API');
    return false;
  }
  try {
    if (api.hasDocument) {
      const exists = await api.hasDocument();
      if (exists) return true;
    }
  } catch {
    // 旧版 Chrome 无 hasDocument，直接尝试创建
  }
  try {
    await api.createDocument({
      url: browser.runtime.getURL('/offscreen.html'),
      reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
      justification:
        '后台播放阅读 BGM，并离线解码音频、构造 WAV 二进制样本完成歌曲听感画像',
    });
    logger.info('offscreen document 已创建');
  } catch (e) {
    logger.debug('createDocument 跳过:', (e as Error).message);
    return api.hasDocument ? api.hasDocument().catch(() => false) : false;
  }
  return true;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const api = getOffscreenApi();
  if (!api?.hasDocument) return true; // 无法探测时假定存在，指令失败会静默
  try {
    return await api.hasDocument();
  } catch {
    return true;
  }
}

export async function wakeAudioWorker(): Promise<void> {
  if (!await ensureOffscreenDocument()) throw new Error('当前浏览器无法启动音频识别文档');
  const response = await browser.runtime.sendMessage({ type: 'OFFSCREEN_AUDIO_WORK' });
  if (!response?.ok) throw new Error('音频识别文档未确认任务，请重新加载扩展');
}

export async function cancelAudioWorker(): Promise<void> {
  if (await hasOffscreenDocument())
    await browser.runtime.sendMessage({ type: 'OFFSCREEN_AUDIO_CANCEL' }).catch(() => {});
}

export async function playInOffscreen(cmd: {
  url: string;
  trackId: string;
  title: string;
  volume: number;
  fadeInMs?: number;
  positionSec?: number;
  fadeOutMs?: number;
  hardCut?: boolean;
  startDeadline?: number;
}): Promise<PlaybackResult> {
  if (!(await ensureOffscreenDocument())) throw new Error('无法创建音频文档');
  return sendPlaybackCommand({ type: 'OFFSCREEN_PLAY', ...cmd });
}

async function sendPlaybackCommand(cmd: object): Promise<PlaybackResult> {
  const result = await browser.runtime.sendMessage(cmd) as PlaybackResult | undefined;
  if (!result?.state) throw new Error('音频文档未确认播放结果');
  return result;
}

export async function pauseInOffscreen(): Promise<PlaybackResult> {
  if (!(await hasOffscreenDocument())) return {
    ok: true, state: { status: 'stopped', trackId: null, title: null, volume: 40 },
  };
  return sendPlaybackCommand({ type: 'OFFSCREEN_PAUSE' });
}

export async function resumeInOffscreen(): Promise<PlaybackResult> {
  if (!(await ensureOffscreenDocument())) throw new Error('无法创建音频文档');
  return sendPlaybackCommand({ type: 'OFFSCREEN_RESUME' });
}

export async function preloadInOffscreen(url: string): Promise<void> {
  if (await hasOffscreenDocument())
    await browser.runtime.sendMessage({ type: 'OFFSCREEN_PRELOAD', url });
}

export async function setVolumeInOffscreen(volume: number): Promise<void> {
  if (!(await hasOffscreenDocument())) return;
  await browser.runtime.sendMessage({ type: 'OFFSCREEN_SET_VOLUME', volume });
}

// 向离屏文档核对真实播放态；文档不存在 / 无响应时返回 null，由调用方回退
export async function getOffscreenPlaybackState(): Promise<PlaybackState | null> {
  if (!(await hasOffscreenDocument())) return null;
  try {
    const res = (await browser.runtime.sendMessage({
      type: 'OFFSCREEN_GET_STATE',
    })) as PlaybackState | undefined;
    if (res && typeof res === 'object' && 'status' in res) return res;
    return null;
  } catch {
    return null;
  }
}
