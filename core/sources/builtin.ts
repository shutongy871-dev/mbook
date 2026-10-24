// 内置 CC0 适配器：永远可用，外部源全挂时的保底
import { CC0_TRACKS } from '@/assets/cc0/manifest';
import type { MusicSourceAdapter, SourceTrack } from './types';

export const builtinAdapter: MusicSourceAdapter = {
  id: 'builtin',
  async fetchLibrary() {
    return { tracks: await this.search('', 10), state: 'connected' };
  },

  async search(): Promise<SourceTrack[]> {
    // CC0 直接从清单读取，不参与外部同步搜索
    return CC0_TRACKS.map((t) => ({
      source: 'builtin',
      sourceSongId: t.id,
      title: t.title,
      artist: t.artist,
      album: '',
      durationSec: t.duration_sec,
      hasLyrics: false,
      bitrateKbps: t.bitrate_kbps,
      popularityRaw: 0,
      streamUrl: t.url,
      urlExpireAt: 0,
      playable: true,
    }));
  },

  async resolveUrl(track: SourceTrack): Promise<SourceTrack | null> {
    return track; // 扩展内置地址永不过期
  },
};
