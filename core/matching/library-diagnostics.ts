import type { AudioTagJob, Settings, Song, SongProfile } from '@/core/shared/contracts';
import { isEmotionVector } from '@/core/understanding/emotion';
import { songToCandidate } from './candidate-pool';
import { filterReasons } from './hard-filter';
import { qualityScore } from './ranking-metrics';

export const DIAGNOSTIC_LABELS = {
  pending: '待画像', invalid_profile: '无有效画像', vocals: '人声过滤',
  unplayable: '不可播', other: '其他阻挡', eligible: '可参与匹配',
} as const;
export type DiagnosticCategory = keyof typeof DIAGNOSTIC_LABELS;

export interface LibraryDiagnosticRow {
  id: string;
  title: string;
  artist: string;
  album: string;
  profileStatus: Song['profile_status'];
  vector: number[] | null;
  categories: DiagnosticCategory[];
  reasons: Array<{ code: string; message: string }>;
  notes: string[];
  primaryReason: string | null;
  eligible: boolean;
  qualityScore: number;
  hasLyrics: boolean;
  vocalDensity: number | null;
  playable: boolean;
  lastProbeAt: number | null;
  lastTagAttempt: number | null;
  profileSource: 'audio_model' | 'metadata' | 'none';
  audioJob?: AudioTagJob;
}

export interface LibraryDiagnostics {
  generatedAt: number;
  policy: Pick<Settings, 'lyric_policy' | 'style_blacklist' | 'netease_enabled'>;
  total: number;
  blocked: number;
  counts: Record<DiagnosticCategory, number>;
  rows: LibraryDiagnosticRow[];
}

// SQL等效口径：songs LEFT JOIN songProfiles USING(song_id)，保留拉黑/未画像记录；
// 每类 COUNT(DISTINCT song_id) 可重叠；blocked = COUNT(有至少一个阻挡原因)。
// pending 不计 invalid_profile；eligible 表示通过入池+硬过滤，不保证播放地址解析成功。
export function diagnoseLibrary(songs: Song[], profiles: SongProfile[], settings: Settings,
  now = Date.now(), audioJobs: AudioTagJob[] = []): LibraryDiagnostics {
  const byId = new Map(profiles.map(profile => [profile.song_id, profile]));
  const jobsById = new Map(audioJobs.map(job => [job.song_id, job]));
  const rows = songs.filter(song => (song.primary_source ?? song.song_id.split(':')[0]) === 'netease')
    .map((song): LibraryDiagnosticRow => {
      const profile = byId.get(song.song_id);
      const candidate = songToCandidate(song, profile, now);
      const vector = profile?.emotion_vector;
      const valid = isEmotionVector(vector) && vector.some(n => n > 0);
      const reasons: LibraryDiagnosticRow['reasons'] = [];
      const notes: string[] = [];
      const categories: DiagnosticCategory[] = [];
      const add = (category: DiagnosticCategory, code: string, message: string) => {
        if (!categories.includes(category)) categories.push(category);
        reasons.push({ code, message });
      };
      if (song.blacklisted) add('other', 'blacklisted', '已被点踩拉黑，不进入候选池');
      if (song.profile_status === 'pending') {
        add('pending', 'pending', '画像状态为待处理，尚未进入八维候选池');
      } else if (!valid) {
        const message = !profile ? '画像记录缺失' : vector == null ? '画像未产出八维情绪向量' :
          !isEmotionVector(vector) ? '向量不是合法的八维 0～1 数值（可能是旧画像）' :
            '八维全部为 0，没有可匹配的情绪方向';
        add('invalid_profile', 'invalid_profile', message);
      }
      if (!settings.netease_enabled) add('other', 'external_disabled', '网易云外部曲库开关已关闭');
      const vocal = candidate.vocalDensity ?? (candidate.hasLyrics ? .65 : 0);
      const maxVocal = { instrumental_only: .2, instrumental_preferred: .4, any: .8 }[settings.lyric_policy];
      for (const code of filterReasons(candidate, settings)) {
        switch (code) {
          case 'unplayable':
            add('unplayable', code, !song.last_probe_at && !song.load_attempts?.length
              ? '当前可播标记为否，尚无地址探测或播放尝试记录；不能据此认定歌曲永久不可播'
              : '当前可播标记为否；现有记录未保存接口失败细节');
            break;
          case 'copyright': add('unplayable', code, '平台版权可用标记为否'); break;
          case 'duration': add('other', code, `时长 ${song.duration_sec} 秒，不在 60～600 秒范围内`); break;
          case 'quality': add('other', code, `音质/加载稳定性综合分 ${qualityScore(candidate).toFixed(1)} < 70（码率 ${song.bitrate_kbps} kbps${song.bitrate_kbps === 0 ? '，尚无有效码率' : ''}）`); break;
          case 'lyrics': add('vocals', code, '只要纯音乐策略：平台信息标记有歌词'); break;
          case 'vocal_density':
            add('vocals', code, `人声密度 ${vocal.toFixed(2)} > 当前门槛 ${maxVocal.toFixed(2)}（${candidate.vocalDensity == null ? '未实测，按歌词标记估算' : '画像中的密度值'}）`);
            break;
          case 'style':
            add('other', code, `画像标签命中风格黑名单：${candidate.tags.filter(tag =>
              settings.style_blacklist.some(style => style.trim() && tag.toLowerCase().includes(style.trim().toLowerCase()))).join('、')}`);
            break;
        }
      }
      if (song.profile_status === 'failed') notes.push(valid
        ? '画像任务失败，但已有有效八维兜底画像，失败状态本身不阻止匹配'
        : '画像任务标记失败，未记录具体失败详情');
      if (candidate.vocalDensity == null) notes.push(`人声未实测；当前规则按 has_lyrics=${song.has_lyrics} 估算为 ${vocal.toFixed(2)}`);
      if (song.playable && song.url_expire_at <= now + 60_000) notes.push('地址为空、已过期或即将过期，播放前需要重新解析；不因此额外计为不可播');
      const eligible = reasons.length === 0;
      if (eligible) categories.push('eligible');
      return {
        id: song.song_id, title: song.title, artist: song.artist, album: song.album,
        profileStatus: song.profile_status, vector: isEmotionVector(vector) ? [...vector] : null,
        categories, reasons, notes, primaryReason: reasons[0]?.code ?? null, eligible,
        qualityScore: qualityScore(candidate), hasLyrics: song.has_lyrics,
        vocalDensity: candidate.vocalDensity ?? null, playable: song.playable,
        lastProbeAt: song.last_probe_at ?? null, lastTagAttempt: song.last_tag_attempt ?? null,
        profileSource: profile?.audio_emotion?.emotion ? 'audio_model' : profile?.emotion_vector ? 'metadata' : 'none',
        audioJob: jobsById.get(song.song_id),
      };
    }).sort((a, b) => Number(a.eligible) - Number(b.eligible) ||
      a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
  const counts = Object.fromEntries(Object.keys(DIAGNOSTIC_LABELS).map(category => [
    category, rows.filter(row => row.categories.includes(category as DiagnosticCategory)).length,
  ])) as Record<DiagnosticCategory, number>;
  return {
    generatedAt: now, policy: { lyric_policy: settings.lyric_policy,
      style_blacklist: [...settings.style_blacklist], netease_enabled: settings.netease_enabled },
    total: rows.length, blocked: rows.filter(row => !row.eligible).length, counts, rows,
  };
}
