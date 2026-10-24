// 音乐源适配器统一接口（方案 1.3 原则 3：适配器隔离变化）
// 新增音源（汽水/抖音/QQ）只需实现本接口，主链路不动

import type { PlatformPopularity } from '@/core/shared/contracts';

export interface SourceTrack {
  source: string; // 'netease' | 'soda' ...
  sourceSongId: string; // 音源侧原始 id
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  hasLyrics: boolean;
  bitrateKbps: number;
  popularityRaw: number; // 平台热度（无则 0）
  popularityMetrics?: PlatformPopularity;
  streamUrl: string; // 可播地址；搜索阶段可为空，播放前 resolve
  urlExpireAt: number; // 地址过期时间戳，0 表示不过期
  playable: boolean;
  copyrightAvailable?: boolean;
  language?: string;
  channels?: string[];
  platformTags?: string[];
  playlistTags?: string[];
}

export interface LibraryResult {
  tracks: SourceTrack[];
  state: 'signed_out' | 'connected';
  name?: string;
}

export interface MusicSourceAdapter {
  id: string;
  fetchLibrary(): Promise<LibraryResult>;
  // 关键词搜索（同步曲库用）
  search(keyword: string, limit: number): Promise<SourceTrack[]>;
  // 解析/刷新可播地址（返回带 streamUrl 的新对象；失败返回 null）
  resolveUrl(track: SourceTrack, signal?: AbortSignal): Promise<SourceTrack | null>;
}
