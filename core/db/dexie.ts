import Dexie, { type Table } from 'dexie';
import type { ReadingAnalysisRecord } from './reading-analysis.repo';
import type {
  LtrModel,
  AudioTagJob,
  AudioTagBudget,
  SceneStat,
  Settings,
  Song,
  SongProfile,
  UserEvent,
} from '@/core/shared/contracts';

// settings 表单条存储：{ key: 'app', value: Settings }；另复用存 CC0 黑名单等杂项
interface SettingsRow {
  key: string;
  value: Settings | { cc0?: string[] } | AudioTagBudget;
}

class MBookDB extends Dexie {
  songs!: Table<Song, string>;
  songProfiles!: Table<SongProfile, string>;
  userEvents!: Table<UserEvent, number>;
  sceneStats!: Table<SceneStat, [string, string]>;
  settings!: Table<SettingsRow, string>;
  ltrModel!: Table<LtrModel, string>;
  readingAnalyses!: Table<ReadingAnalysisRecord, number>;
  audioJobs!: Table<AudioTagJob, string>;

  constructor() {
    super('mbook');
    this.version(1).stores({
      // 索引与 PRD 字段字典对齐
      songs: 'song_id, dedup_key, last_matched_at, tag_version, blacklisted',
      songProfiles: 'song_id',
      userEvents: '++id, ts, song_id, scene_bucket',
      sceneStats: '[scene_bucket+song_id], scene_bucket, song_id, updated_at',
      settings: 'key',
      ltrModel: 'id',
    });
    this.version(2).stores({}).upgrade(async tx => {
      await tx.table<Song>('songs').toCollection().modify(song => {
        const norm = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
        song.dedup_key = `${norm(song.title)}|${norm(song.artist)}|${Math.round(song.duration_sec / 3)}`;
        song.primary_source ??= song.song_id.split(':')[0];
        song.source_song_id ??= song.song_id.split(':')[1];
      });
    });
    this.version(3).stores({
      readingAnalyses: '++id, ts, windowId',
    });
    this.version(4).stores({}).upgrade(async tx => {
      // 清除旧情绪字段，保留音频实测、曲库、用户反馈和阅读证据。
      await tx.table<SongProfile>('songProfiles').toCollection().modify(profile => {
        profile.emotion_vector = null;
        delete profile.emotion_sources;
      });
      await tx.table<Song>('songs').toCollection().modify(song => {
        song.tag_version = '';
        song.profile_status = 'pending';
        delete song.last_tag_attempt;
      });
      await tx.table('ltrModel').clear();
      await tx.table('sceneStats').clear();
    });
    this.version(5).stores({ audioJobs: 'song_id, status' });
  }
}

export const db = new MBookDB();
