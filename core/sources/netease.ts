// 网易云音乐适配器：weapi 加密请求，SW 内 fetch（host 权限已在 manifest 声明）
// 降级约定：任何网络/解析失败返回空数组或 null，主链路自动回退 CC0

import { weapi } from './netease-crypto';
import { logger } from '@/core/shared/logger';
import type { MusicSourceAdapter, SourceTrack } from './types';
import { browser } from 'wxt/browser';

const BASE = 'https://music.163.com';
const FETCH_TIMEOUT_MS = 8000;
let requestQueue: Promise<unknown> = Promise.resolve();
let nextRequestAt = 0;

async function weapiPost(path: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  // Shared lane for sync/tag/play-address traffic; avoid burst requests across callers.
  const result = requestQueue.then(async () => {
    signal?.throwIfAborted();
    const delay = nextRequestAt - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    signal?.throwIfAborted();
    nextRequestAt = Date.now() + 350 + Math.floor(Math.random() * 150);
    return sendWeapi(path, payload, signal);
  });
  requestQueue = result.catch(() => {});
  return result;
}

async function sendWeapi(path: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const csrf = (await browser.cookies.get({ url: BASE, name: '__csrf' }).catch(() => null))?.value ?? '';
  const form = await weapi({ ...payload, csrf_token: csrf });
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}?csrf_token=${encodeURIComponent(csrf)}`, {
      method: 'POST',
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      // 携带用户在浏览器登录 music.163.com 网页版后的登录 cookie（技术方案 4.2：
      // host_permissions 下 SW fetch 自动复用平台登录态，无需在扩展内做登录/部署）。
      // 未登录时平台可能拒绝搜索或取流，失败回退 CC0。
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `params=${encodeURIComponent(form.params)}&encSecKey=${form.encSecKey}`,
    });
    if (!res.ok) throw new Error(`netease http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function asSongs(json: unknown): any[] {
  const root = json as { result?: { songs?: any[] }; songs?: any[] };
  return root?.result?.songs ?? root?.songs ?? [];
}

function normalizeSong(raw: any): SourceTrack | null {
  if (!raw?.id || !raw?.name) return null;
  const artists: any[] = raw.ar ?? raw.artists ?? [];
  const album = raw.al ?? raw.album ?? {};
  const durationMs = raw.dt ?? raw.duration ?? 0;
  return {
    source: 'netease',
    sourceSongId: String(raw.id),
    title: String(raw.name).trim(),
    artist: artists[0]?.name || '未知艺人',
    album: album?.name ?? '',
    durationSec: Math.round(durationMs / 1000),
    // Unknown vocals are treated conservatively until a lyric response proves instrumental.
    hasLyrics: true,
    bitrateKbps: 0,
    popularityRaw: Math.round(raw.pop ?? 0),
    streamUrl: '',
    urlExpireAt: 0,
    playable: false,
    copyrightAvailable: raw.noCopyrightRcmd == null && raw.st !== -200,
    channels: ['netease_search'],
  };
}

export const neteaseAdapter: MusicSourceAdapter = {
  id: 'netease',

  async fetchLibrary() {
    const account = await weapiPost('/weapi/w/nuser/account/get', {}) as {
      code?: number; profile?: { userId: number; nickname?: string };
    };
    if (account.code !== 200 && account.code !== 301) throw new Error('账号状态查询失败');
    if (!account.profile?.userId) return { tracks: [], state: 'signed_out' };
    const tracks: SourceTrack[] = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = await weapiPost('/weapi/user/playlist', {
        uid: account.profile.userId, offset, limit: 100, includeVideo: false,
      }) as { code?: number; more?: boolean; playlist?: Array<{ id: number; tags?: string[] }> };
      if (page.code !== 200 || !page.playlist) throw new Error('无法读取个人歌单');
      for (const playlist of page.playlist) {
        const detail = await weapiPost('/weapi/v6/playlist/detail', { id: playlist.id, n: 1000, s: 0 }) as {
          code?: number; playlist?: { tracks?: any[]; trackIds?: Array<{ id: number }>; tags?: string[] };
        };
        if (detail.code !== 200 || !detail.playlist) throw new Error('歌单详情不可用');
        const rawTracks = [...detail.playlist.tracks ?? []];
        const present = new Set(rawTracks.map(t => t.id));
        const missing = (detail.playlist.trackIds ?? []).filter(t => !present.has(t.id));
        for (let i = 0; i < missing.length; i += 200) {
          const extra = await weapiPost('/weapi/v3/song/detail', { c: JSON.stringify(missing.slice(i, i + 200)) });
          const response = extra as { code?: number };
          if (response.code != null && response.code !== 200) throw new Error('歌单曲目补齐失败');
          const songs = asSongs(extra);
          if (!songs.length) throw new Error('歌单曲目补齐结果为空');
          rawTracks.push(...songs);
        }
        for (const raw of rawTracks) {
          const song = normalizeSong(raw);
          if (song) tracks.push({ ...song, channels: ['netease_playlist'],
            playlistTags: detail.playlist.tags ?? playlist.tags ?? [] });
        }
      }
      if (!page.more || !page.playlist.length) break;
    }
    const unique = new Map<string, SourceTrack>();
    for (const track of tracks) {
      const previous = unique.get(track.sourceSongId);
      unique.set(track.sourceSongId, previous ? { ...track,
        playlistTags: [...new Set([...(previous.playlistTags ?? []), ...(track.playlistTags ?? [])])],
      } : track);
    }
    return { tracks: [...unique.values()], state: 'connected', name: account.profile.nickname };
  },

  async search(keyword: string, limit: number): Promise<SourceTrack[]> {
    try {
      const json = await weapiPost('/weapi/cloudsearch/get/web', {
        s: keyword,
        type: 1,
        offset: 0,
        limit,
      });
      return asSongs(json)
        .map(normalizeSong)
        .filter((s): s is SourceTrack => s !== null)
        .filter((s) => s.durationSec >= 60 && s.durationSec <= 600);
    } catch (e) {
      logger.warn(`[netease] 搜索「${keyword}」失败（将回退本地曲库）:`, (e as Error).message);
      return [];
    }
  },

  async resolveUrl(track: SourceTrack, signal?: AbortSignal): Promise<SourceTrack | null> {
    try {
      const json = await weapiPost('/weapi/song/enhance/player/url/v1', {
        ids: [Number(track.sourceSongId)],
        level: 'standard',
        encodeType: 'aac',
      }, signal);
      const data = (json as { data?: any[] })?.data?.[0];
      if (!data?.url || data.freeTrialInfo || (data.code != null && data.code !== 200)) return null;
      return {
        ...track,
        streamUrl: String(data.url),
        bitrateKbps: Number.isFinite(data.br) && data.br > 0 ? Math.round(data.br / 1000) : 0,
        urlExpireAt: Date.now() + Math.max(60, data.expi ?? 1800) * 1000,
        playable: true,
        copyrightAvailable: true,
      };
    } catch (e) {
      if (signal?.aborted) return null;
      logger.warn('[netease] 解析播放地址失败:', (e as Error).message);
      return null;
    }
  },
};

export async function inspectLyrics(sourceSongId: string): Promise<{ hasLyrics: boolean; language: string } | null> {
  try {
    const data = await weapiPost('/weapi/song/lyric', { id: Number(sourceSongId), lv: -1, tv: -1 }) as {
      nolyric?: boolean; lrc?: { lyric?: string };
    };
    const lyric = data.lrc?.lyric?.replace(/\[[^\]]*\]/g, '').trim() ?? '';
    if (data.nolyric || /纯音乐[，, ]*请欣赏/.test(lyric))
      return { hasLyrics: false, language: 'instrumental' };
    if (!lyric) return null;
    return { hasLyrics: true, language: /[\u4e00-\u9fff]/.test(lyric.slice(0, 200)) ? 'zh' : 'other' };
  } catch { return null; }
}
