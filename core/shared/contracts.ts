// ===== 全局类型契约：字段口径与 PRD 保持一致 =====

// 固定八维顺序：喜悦、悲伤、温柔、希望、恐惧、愤怒、神秘、庄严；每维0～1。
// 外部/持久化边界由EmotionSchema和isEmotionVector校验长度及范围。
export type EmotionVector = number[];

export interface AudioSegment {
  index: number;
  start_sec: number; // 原曲位置
  duration_sec: number;
  input_start_sec: number; // 拼接后输入位置
}

export interface AudioEmotionProfile {
  version: string;
  identity: string;
  model: string;
  analyzed_at: number;
  sampled_sec: number;
  coverage: number; // 有有效画像的采样时长 / 总采样时长
  emotion: EmotionVector | null;
  segments: Array<AudioSegment & {
    emotion: EmotionVector | null;
    confidence: number; // 模型自评，并非实测准确率
    evidence: string;
  }>;
  usage?: { input_tokens: number; output_tokens: number; audio_tokens?: number; text_tokens?: number };
}

export interface AudioTagJob {
  song_id: string;
  identity: string;
  status: 'queued' | 'processing' | 'complete' | 'unknown' | 'failed';
  attempts: number;
  updated_at: number;
  lease_until?: number;
  request_id?: string;
  error?: string;
  result?: AudioEmotionProfile;
}

export interface AudioTagBudget {
  attempts: number; // 累计领取任务次数；失败也计入，不因重启/改配置而重置
  halted?: string;
}

// ===== IndexedDB 六张表的实体 =====

// 只接受上游同一 7 日窗口的计数；本地播放/喜欢不能替代平台指标。
export interface PlatformPopularity {
  provider: string;
  window_end: number;
  plays7d: number;
  exposures7d: number;
  playlistGrowth7d: number;
}

export interface Song {
  song_id: string;
  dedup_key: string;
  source_channels: string[];
  title: string;
  artist: string;
  album: string;
  duration_sec: number;
  has_lyrics: boolean;
  language: string;
  bitrate_kbps: number;
  audio_format: string;
  stream_url: string;
  url_expire_at: number;
  playable: boolean;
  copyright_available: boolean;
  backup_sources: Array<{ source: string; url: string; sourceSongId?: string; expireAt?: number }>;
  source_song_id?: string;
  primary_source?: string;
  platform_tags?: string[];
  playlist_tags?: string[];
  popularity_raw?: number;
  popularity_metrics?: PlatformPopularity;
  last_tag_attempt?: number;
  last_probe_at?: number;
  load_attempts?: Array<{ ts: number; ok: boolean }>;
  added_at: number;
  first_seen_at: number;
  last_matched_at: number;
  blacklisted: boolean;
  tag_version: string;
  profile_status: 'pending' | 'audio_done' | 'llm_done' | 'failed';
}

export interface SongProfile {
  song_id: string;
  emotion_vector: EmotionVector | null;
  audio_emotion?: AudioEmotionProfile;
  emotion_sources?: { llm?: EmotionVector; platform?: EmotionVector };
  music_tags: Array<{ tag: string; confidence: number }>;
  llm_tags?: Array<{ tag: string; confidence: number }>;
  semantic_text: string;
  semantic_embedding: number[];
  embedding_model?: string;
  audio_analysis_status?: 'pending' | 'complete' | 'unavailable';
  audio_features: {
    bpm: number;
    vocal_density: number | null; // null: HPSS 未验证，不能用假值冒充实测
    dynamic_range: number;
    energy_curve: number[];
    spectral_centroid_hz?: number; // 频谱质心，仅作为音色明亮度代理，不代表乐器或人声识别
  } | null;
  popularity_raw: number;
  popularity_score: number;
  popularity_basis?: 'platform_metrics' | 'platform_proxy' | 'neutral';
  popularity_updated_at?: number;
  platform_tags: string[];
}

export type UserAction =
  | 'play_start'
  | 'sustained_play'
  | 'like'
  | 'full_play'
  | 'quick_skip'
  | 'dislike'
  | 'close_plugin'
  | 'manual_switch';

export interface UserEvent {
  id?: number;
  ts: number;
  window_id: string;
  song_id: string;
  action: UserAction;
  scene_bucket: string;
  context_features: Record<string, number | string>;
  decision?: DecisionSnapshot;
}

// Versioned numerical snapshot only; reading text never enters the event store.
export interface DecisionSnapshot {
  version: string;
  features: number[];
  bandit: number[];
  indicators: number[];
}

export interface SceneStat {
  scene_bucket: string;
  song_id: string;
  match_score: number;
  play_count: number;
  complete_count: number;
  skip_count: number;
  updated_at: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  endpoint: string;
  api_key: string;
  model: string;
}

export interface Settings {
  // 最多一个共享模型；两个任务ID非空表示勾选，旧字段作为运行时投影与迁移输入。
  models?: ModelConfig[];
  text_model_id?: string | null;
  music_model_id?: string | null;
  update_interval_sec: number;
  window_size: number;
  fade_out_ms: number;
  fade_in_ms: number;
  ai_strength: 'off' | 'standard' | 'strong';
  llm_endpoint: string;
  llm_key: string;
  lyric_policy: 'instrumental_only' | 'instrumental_preferred' | 'any';
  bpm_ranges: { calm: [number, number]; peak: [number, number] };
  style_blacklist: string[];
  source_weight: 'balanced' | 'douyin_first' | 'soda_first';
  enabled_sources: string[];
  base_volume: number; // 0-100，播放层参数，不参与打分
  autoplay: boolean;
  auto_pause: boolean;
  plugin_enabled: boolean; // 插件总开关（关插件触发归因：门槛上调）
  netease_enabled: boolean; // 网易云外部曲库开关（关时仅用 CC0）
  llm_model: string; // BYOK 模型名（空则用 gpt-4o-mini 兜底）
  song_audio_enabled: boolean;
  song_audio_endpoint: string;
  song_audio_key: string;
  song_audio_model: string;
  song_audio_limit: number;
  embedding_model?: string;
  netease_search_supplement?: boolean;
  floating_ball: boolean; // 网页悬浮球开关
  vocal_penalty: number; // 关闭插件负反馈累加的人声惩罚，0–0.5
}

export interface LtrModel {
  id: string;
  model_binary: Blob | null;
  feature_version: string;
  sample_count: number;
  last_trained_at: number;
  weights?: number[];
  bias?: number;
  last_event_id?: number;
  bandit_inverse?: number[][];
  bandit_b?: number[];
}

// ===== CC0 内置曲目 =====

export interface Cc0Track {
  id: string;
  title: string;
  artist: string;
  mood_label: string;
  mood_emoji: string;
  bpm: number;
  emotion: EmotionVector;
  tags: string[];
  url: string;
  duration_sec: number;
  bitrate_kbps: number;
}

// ===== 阅读采集（Step 2，仅驻留内存，不入库）=====

// 阅读三态：专注阅读 / 快速浏览 / 未激活（切走标签页等）
export type ReadingStateName = 'focused' | 'scanning' | 'inactive';

export interface ReadingState {
  url: string;
  host: string;
  title: string;
  extractor: string; // 命中的站点适配器：weread / generic / none
  chapter: string | null; // 章节标题（识别不到为 null）
  window_id: string | null; // hash(章节 + 起始段落 + 当前窗口正文)
  state: ReadingStateName;
  is_reading: boolean;
  page_active: boolean; // 标签页是否可见
  stay_sec: number; // 页面可见累计停留秒数
  visible_text_len: number; // 当前视口内可见正文字数
  paragraph_count: number; // 抽取到的正文段落总数
  first_visible_index: number; // 视口内最靠上的段落序号，无则 -1
  scroll_speed_sps: number; // 滚动速度（屏/秒）
  reading_speed_cpm: number; // 阅读速度（字/分钟）
  reading_speed_known?: boolean; // 无翻页/滚动进度时不能从停留推断真实速度
  visible_text?: string; // 视口内可见正文片段；分析时保存至本地readingAnalyses供命中核查
  updated_at: number;
}

// Content Script -> Background：心跳上报（每秒采样、每 2 秒 + 状态变化时发送）
export interface ReadingHeartbeatMessage {
  type: 'READING_HEARTBEAT';
  state: ReadingState;
}

// ===== 播放状态与跨上下文消息 =====

export type PlaybackStatus = 'stopped' | 'playing' | 'paused';

export interface PlaybackState {
  status: PlaybackStatus;
  trackId: string | null;
  title: string | null;
  volume: number; // 0-100
  blocked?: boolean; // 浏览器自动播放策略拦截：零交互时起播失败，需用户点一次解锁
  positionSec?: number;
  error?: string;
}

export interface PlaybackResult {
  ok: boolean;
  state: PlaybackState;
  error?: string;
}

// Popup / 其他上下文 -> Background
export type BackgroundMessage =
  | { type: 'GET_STATUS' }
  | { type: 'PLAY'; trackId: string }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'NEXT_TRACK' }
  | { type: 'SET_MOOD'; emotion: EmotionVector | null }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'LIKE_TRACK'; trackId: string }
  | { type: 'DISLIKE_TRACK'; trackId: string }
  | { type: 'SET_ENABLED'; enabled: boolean }
  | { type: 'UPDATE_SETTINGS'; patch: Partial<Settings> }
  | { type: 'SYNC_MUSIC' }
  | { type: 'AUDIO_TAG_START'; songId?: string }
  // 网页悬浮球专用轻量通道：只回显隐/总开关/播放态，不触发自动决策
  | { type: 'GET_BALL_STATE' };

// Background -> Offscreen
export type OffscreenCommand =
  | {
      type: 'OFFSCREEN_PLAY';
      url: string;
      trackId: string;
      title: string;
      volume: number;
      fadeInMs?: number;
      positionSec?: number;
      fadeOutMs?: number;
      hardCut?: boolean;
      startDeadline?: number;
    }
  | { type: 'OFFSCREEN_PRELOAD'; url: string }
  | { type: 'OFFSCREEN_PAUSE' }
  | { type: 'OFFSCREEN_RESUME' }
  | { type: 'OFFSCREEN_SET_VOLUME'; volume: number }
  // SW 休眠唤醒后内存态丢失，用它向离屏文档核对真实播放态，响应为 PlaybackState
  | { type: 'OFFSCREEN_GET_STATE' };

// Offscreen -> 全局广播
export interface OffscreenStateMessage {
  type: 'OFFSCREEN_STATE';
  state: PlaybackState;
}

// Offscreen -> SW：曲目自然播完（完播归因）
export interface OffscreenEndedMessage {
  type: 'OFFSCREEN_ENDED';
  trackId: string;
  title: string;
}

export interface StatusResponse {
  ok: boolean;
  persisted: boolean;
  storage_protected?: boolean; // persist 授权或 unlimitedStorage 任一提供抗逐出保护
  cc0Count: number;
  playback: PlaybackState;
  reading: ReadingState | null; // 当前活动标签页的阅读采集态（无内容脚本/非网页为 null）
  mood?: MoodDebugInfo | null; // 情绪选歌调试信息（词典/LLM 命中的情绪与最佳候选）
  enabled: boolean; // 插件总开关
  stats: DashboardStats; // 数据看板 5 项
  llm_ready: boolean; // 是否已配置可用 LLM
  text_analysis?: { source: 'dictionary' | 'model'; status: 'idle' | 'pending' | 'complete' | 'failed'; error?: string };
  syncing: boolean; // 曲库同步中标记
  source_status?: { state: 'unknown' | 'signed_out' | 'connected' | 'error'; name?: string; last_sync?: number; message?: string;
    library_count?: number; playable_count?: number };
  manual_mood_until?: number;
}

// 数据看板（Step 8）：5 项核心指标
export interface DashboardStats {
  external_count: number; // 外部曲库入库歌曲数
  tagged_count: number; // 已完成画像（LLM 或本地兜底）的歌曲数
  event_count: number; // 累计反馈事件数
  complete_rate: number; // 完播率 0-100
  dislike_count: number; // 点踩歌曲数
  switch_count: number; // 切歌次数
}

// 情绪分析结果（Popup 调试区展示，仅内存）
export interface MoodDebugInfo {
  vector: EmotionVector;
  confidence: number; // 0-1；无词典命中为0
  hit_count: number; // 本次窗口命中的词典词数
  top_title: string | null; // 当前情绪下排名第一的候选曲
  top_score: number | null; // 八维余弦相似度×100，零向量无方向
}
