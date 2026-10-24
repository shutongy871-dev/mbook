import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { CC0_TRACKS } from '@/assets/cc0/manifest';
import { MANUAL_EMOTIONS } from '@/core/understanding/emotion';
import { EMOTION_DIMENSIONS, EMOTION_LABELS } from '@/core/understanding/emotion-dictionary';
import { onPlaybackState, sendToBackground } from '@/core/shared/messaging';
import type {
  DashboardStats,
  BackgroundMessage,
  MoodDebugInfo,
  PlaybackState,
  ReadingState,
  ReadingStateName,
  StatusResponse,
} from '@/core/shared/contracts';

const INITIAL_STATE: PlaybackState = {
  status: 'stopped',
  trackId: null,
  title: null,
  volume: 40,
};

const EMPTY_STATS: DashboardStats = {
  external_count: 0,
  tagged_count: 0,
  event_count: 0,
  complete_rate: 0,
  dislike_count: 0,
  switch_count: 0,
};

const READING_LABEL: Record<ReadingStateName, string> = {
  focused: '🟢 专注阅读',
  scanning: '🟡 快速浏览',
  inactive: '⚪ 未激活',
};

const EXTRACTOR_LABEL: Record<string, string> = {
  weread: '微信读书',
  'weread-api': '微信读书（接口与 DOM）',
  'weread-canvas': '微信读书（可见画布文字）',
  generic: '通用正文抽取',
  none: '非阅读页',
};

const SIGNAL_STALE_MS = 6000;

export default function App() {
  const [state, setState] = useState<PlaybackState>(INITIAL_STATE);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [reading, setReading] = useState<ReadingState | null>(null);
  const [mood, setMood] = useState<MoodDebugInfo | null>(null);
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
  const [enabled, setEnabled] = useState(true);
  const [llmReady, setLlmReady] = useState(false);
  const [textAnalysis, setTextAnalysis] = useState<StatusResponse['text_analysis']>();
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<StatusResponse['source_status']>();
  const [manualUntil, setManualUntil] = useState(0);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
    const res = (await sendToBackground({ type: 'GET_STATUS' })) as
      | StatusResponse
      | undefined;
    if (res) {
      setState(res.playback);
      setPersisted(res.storage_protected ?? res.persisted);
      setReading(res.reading);
      setMood(res.mood ?? null);
      setStats(res.stats);
      setEnabled(res.enabled);
      setLlmReady(res.llm_ready);
      setTextAnalysis(res.text_analysis);
      setSyncing(res.syncing);
      setSource(res.source_status);
      setManualUntil(res.manual_mood_until ?? 0);
    }
    } catch { setError('连接扩展失败，请重新打开面板。'); }
  }, []);

  useEffect(() => {
    void refresh();
    const off = onPlaybackState((msg) => setState(msg.state));
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [refresh]);

  const command = async (msg: BackgroundMessage) => {
    if (busy && msg.type !== 'PAUSE') return;
    setBusy(true);
    try {
      await sendToBackground(msg);
      setError('');
      await refresh();
    } catch { setError('操作失败，请重试。'); }
    finally { setBusy(false); }
  };

  const toggleTrack = async (trackId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (state.status === 'playing' && state.trackId === trackId) {
        await sendToBackground({ type: 'PAUSE' });
      } else if (state.trackId === trackId) {
        await sendToBackground({ type: 'RESUME' });
      } else {
        await sendToBackground({ type: 'PLAY', trackId });
      }
      await refresh();
    } catch { setError('播放操作失败，请重试。'); }
    finally {
      setBusy(false);
    }
  };

  const changeVolume = async (v: number) => {
    setState((s) => ({ ...s, volume: v }));
    try { await sendToBackground({ type: 'SET_VOLUME', volume: v }); }
    catch { setError('音量未保存，请重试。'); }
  };

  const feedback = async (kind: 'LIKE_TRACK' | 'DISLIKE_TRACK') => {
    if (!state.trackId || busy) return;
    setBusy(true);
    try {
      await sendToBackground({ type: kind, trackId: state.trackId });
      await refresh();
    } catch { setError('反馈未保存，请重试。'); }
    finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    await command({ type: 'SET_ENABLED', enabled: next });
  };

  const openOptions = () => {
    void browser.runtime.openOptionsPage().catch(() => setError('无法打开设置页，请重试。'));
  };

  const statusText =
    state.status === 'playing'
      ? `正在播放 · ${state.title ?? ''}`
      : state.status === 'paused'
        ? `已暂停 · ${state.title ?? ''}`
        : '未播放';

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">MBook</span>
        </div>
        <button
          className={`switch ${enabled ? 'switch-on' : 'switch-off'}`}
          onClick={() => void toggleEnabled()}
          title={enabled ? '点击关闭 MBook' : '点击开启 MBook'}
        >
          {enabled ? '已开启' : '已关闭'}
        </button>
      </header>

      <div className={`now-playing ${state.status === 'playing' ? 'is-playing' : ''}`}>
        <span className="np-label">♪</span>
        <span className="np-text">{statusText}</span>
        {state.trackId && (
          <span className="np-actions">
            <button
              className="fb-btn"
              title="喜欢这首"
              onClick={() => void feedback('LIKE_TRACK')}
              disabled={busy}
            >
              👍
            </button>
            <button
              className="fb-btn fb-btn-down"
              title="点踩：这首歌永不再推荐"
              onClick={() => void feedback('DISLIKE_TRACK')}
              disabled={busy}
            >
              👎
            </button>
          </span>
        )}
      </div>

      <div className="np-actions">
        <button disabled={(busy && state.status !== 'playing') || !enabled} onClick={() => void command({ type: state.status === 'playing' ? 'PAUSE' : 'RESUME' })}>
          {state.status === 'playing' ? '暂停' : '播放'}
        </button>
        <button disabled={busy || !enabled} onClick={() => void command({ type: 'NEXT_TRACK' })}>换一首</button>
      </div>
      {error && <div role="alert">{error}</div>}
      {state.error && !state.blocked && <div role="status">播放未成功，请换一首重试。</div>}

      {state.blocked && (
        <div className="blocked-tip">
          🔇 浏览器拦截了自动播放，点下方任意曲目即可开启声音（仅需一次）
        </div>
      )}

      <div className="reading">
        <div className="reading-head">
          <span className="reading-title">📖 阅读采集</span>
          {reading && Date.now() - reading.updated_at < SIGNAL_STALE_MS ? (
            <span className={`rs-badge rs-${reading.state}`}>
              {READING_LABEL[reading.state]}
            </span>
          ) : (
            <span className="rs-badge rs-none">无信号</span>
          )}
        </div>

        {reading && Date.now() - reading.updated_at < SIGNAL_STALE_MS ? (
          <>
            <div className="reading-site">
              {EXTRACTOR_LABEL[reading.extractor] ?? reading.extractor} · {reading.host}
            </div>
            <div className="reading-name" title={reading.title}>
              {reading.chapter ?? reading.title ?? '（未识别章节）'}
            </div>
            <div className="reading-metrics">
              <span>停留 {reading.stay_sec}s</span>
              <span>可见正文 {reading.visible_text_len} 字</span>
              <span>段落 {reading.paragraph_count}</span>
              <span>滚动 {reading.scroll_speed_sps} 屏/秒</span>
              <span>{reading.reading_speed_known === false ? '阅读速度待测' : `阅读 ${reading.reading_speed_cpm} 字/分`}</span>
            </div>
          </>
        ) : (
          <div className="reading-empty">
            当前标签页未检测到阅读信号
            <br />
            打开知乎 / 公众号 / 小说站 / 微信读书等文章页试试
          </div>
        )}
      </div>

      <div className="mood">
        <div className="mood-head">
          <span className="mood-title">🎵 八维匹配分数</span>
          {!mood && (
            <span className="rs-badge rs-none">等待专注阅读</span>
          )}
        </div>
        {mood && (
          <>
            <div className="mood-vec">
              {EMOTION_DIMENSIONS.map((dimension, i) =>
                <span key={dimension}>{EMOTION_LABELS[dimension]} {mood.vector[i]!.toFixed(2)}</span>)}
            </div>
            <div className="mood-metrics">
              <span>置信 {Math.round(mood.confidence * 100)}%</span>
              {!llmReady && <span>命中词 {mood.hit_count}</span>}
            </div>
            <div className="mood-pick">
              {mood.top_title && mood.top_score != null
                ? `🏆 八维匹配首选：${mood.top_title}（相似度 ${mood.top_score}%）`
                : '暂无候选'}
            </div>
          </>
        )}
        <label>
          手动情绪（锁定 10 分钟）
          <select disabled={busy || !enabled} value={manualUntil > Date.now() && mood ? MANUAL_EMOTIONS.find(t =>
            t.vector.every((n, i) => n === mood.vector[i]))?.id ?? '' : ''} onChange={(e) => {
            const t = MANUAL_EMOTIONS.find((track) => track.id === e.target.value);
            void command({ type: 'SET_MOOD', emotion: t?.vector ?? null });
          }}>
            <option value="">自动理解</option>
            {MANUAL_EMOTIONS.map((t) => <option key={t.id} value={t.id}>{t.emoji} {t.label}</option>)}
          </select>
        </label>
        {manualUntil > Date.now() && <span>锁定剩余 {Math.ceil((manualUntil - Date.now()) / 60000)} 分钟 <button onClick={() => void command({ type: 'SET_MOOD', emotion: null })}>恢复自动</button></span>}
      </div>

      <div className="dashboard">
        <div className="dash-title">📊 学习看板</div>
        <div className="dash-grid">
          <div className="dash-item">
            <span className="dash-num">{stats.external_count}</span>
            <span className="dash-label">外部曲库</span>
          </div>
          <div className="dash-item">
            <span className="dash-num">{stats.tagged_count}</span>
            <span className="dash-label">已画像</span>
          </div>
          <div className="dash-item">
            <span className="dash-num">{stats.event_count}</span>
            <span className="dash-label">反馈事件</span>
          </div>
          <div className="dash-item">
            <span className="dash-num">{stats.complete_rate}%</span>
            <span className="dash-label">完播率</span>
          </div>
          <div className="dash-item">
            <span className="dash-num">{stats.switch_count}</span>
            <span className="dash-label">手动换曲</span>
          </div>
        </div>
        <div className="dash-chips">
          <span className={`chip ${llmReady ? 'chip-ok' : 'chip-muted'}`}>
            {llmReady ? textAnalysis?.status === 'pending' ? '🧠 模型识别中' :
              textAnalysis?.status === 'failed' ? '🧠 模型识别失败' : '🧠 模型八维识别' : '🧠 本地词典模式'}
          </span>
          {textAnalysis?.status === 'failed' && <span className="chip chip-muted">{textAnalysis.error}</span>}
          <span className={`chip ${syncing ? 'chip-wait' : 'chip-muted'}`}>
            {syncing ? '☁️ 曲库同步中…' : source?.state === 'connected' ? `☁️ 已连接 ${source.name ?? '网易云'}` : source?.state === 'signed_out' ? '☁️ 网易云未登录' : source?.state === 'error' ? '☁️ 同步失败' : '☁️ 尚未同步'}
          </span>
        </div>
        {source?.message && <div>{source.message}</div>}
        {source?.library_count != null && <div>网易曲库：{source.library_count} 首已入库 · {source.playable_count ?? 0} 首取流探测通过（完整播放仍需验证）</div>}
        {source?.last_sync && <div>上次尝试同步：{new Date(source.last_sync).toLocaleString()}</div>}
        <button disabled={syncing} onClick={() => void command({ type: 'SYNC_MUSIC' })}>同步个人曲库</button>
        <a href="https://music.163.com/" target="_blank" rel="noreferrer">登录网易云</a>
      </div>

      <ul className="track-list">
        {CC0_TRACKS.map((t) => {
          const active = state.trackId === t.id;
          const playing = active && state.status === 'playing';
          return (
            <li key={t.id}>
              <button
                className={`track ${active ? 'track-active' : ''}`}
                onClick={() => void toggleTrack(t.id)}
                disabled={busy}
              >
                <span className="track-icon">{playing ? '⏸' : '▶'}</span>
                <span className="track-meta">
                  <span className="track-title">
                    {t.mood_emoji} {t.title}
                  </span>
                  <span className="track-sub">
                    {t.mood_label} · {t.bpm ? `约 ${t.bpm} BPM` : '自由节奏 / BPM 未确定'} · {t.tags.join(' / ')}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="volume">
        <span className="vol-icon">🔊</span>
        <input
          type="range"
          min={0}
          max={100}
          value={state.volume}
          onChange={(e) => void changeVolume(Number(e.target.value))}
        />
        <span className="vol-value">{state.volume}</span>
      </div>

      <footer className="footer">
        <span>{persisted == null ? '正在检查本地存储' : persisted ? '本地存储已获抗自动清理保护' : '本地存储尚未获得抗自动清理保护'}</span>
        <span>动态 BGM · 读文字算情绪，按情绪选歌切歌</span>
        <button className="options-link" onClick={openOptions}>
          高级设置 ⚙
        </button>
      </footer>
    </div>
  );
}
