import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { CC0_TRACKS } from '@/assets/cc0/manifest';
import { settingsRepo } from '@/core/db/settings.repo';
import { songsRepo } from '@/core/db/songs.repo';
import { profilesRepo } from '@/core/db/profiles.repo';
import { eventsRepo } from '@/core/db/events.repo';
import { readingAnalysisRepo } from '@/core/db/reading-analysis.repo';
import { getOffscreenPlaybackState, pauseInOffscreen, playInOffscreen,
  resumeInOffscreen, setVolumeInOffscreen, wakeAudioWorker, cancelAudioWorker } from '@/core/playback/offscreen-client';
import { enqueueAudioJobs } from '@/core/db/audio-jobs.repo';
import { isEmotionVector, ZERO_EMOTION } from '@/core/understanding/emotion';
import { scoreTextEmotions } from '@/core/understanding/emotion-scoring';
import { analyzeTextWithLlm, type TextEmotionResult } from '@/core/understanding/text-llm';
import { tagSong, TAG_VERSION, fuseSongProfile } from '@/core/understanding/song-tagger';
import { selectSongs, type SelectResult } from '@/core/matching/pipeline';
import type { RankedCandidate } from '@/core/matching/final-rank';
import { isSyncing, resolveBackupUrls, invalidatePlayableUrl,
  syncMusicLibrary, getSourceStatus, probeSong, resolvePlayableUrl } from '@/core/sources';
import { db } from '@/core/db/dexie';
import { feedbackTracker, type Attribution } from '@/core/feedback/attribution';
import { preferenceKeys } from '@/core/feedback/feature-preferences';
import { isLlmConfigured } from '@/core/llm/client';
import { logger } from '@/core/shared/logger';
import { sceneBucket } from '@/core/shared/scene';
import { refreshPopularity } from '@/core/matching/popularity';
import { withinDeadline } from '@/core/shared/deadline';
import { routePlayableUrl } from '@/core/sources/source-router';
import { reinjectOpenWereadTabs } from '@/core/reading/reinject';
import type { BackgroundMessage, DashboardStats, EmotionVector, MoodDebugInfo,
  PlaybackState, ReadingState, Settings, StatusResponse, SongProfile } from '@/core/shared/contracts';

const NEUTRAL: EmotionVector = ZERO_EMOTION;
const SYNC_ALARM = 'mbook-music-sync';
const IDLE_ALARM = 'mbook-idle-check';
const IDLE_DEADLINE = 'mbook-idle-deadline';
const TAG_ALARM = 'mbook-tag-batch';
const CLEANUP_ALARM = 'mbook-daily-cleanup';
let tagging = false;
let candidatePriority: string[] = [];
let lastPlayback: PlaybackState = { status: 'stopped', trackId: null, title: null, volume: 40 };
const readingByTab = new Map<number, ReadingState>();
let activeTabId: number | null = null;
let currentEmotion: EmotionVector | null = null;
let analyzedWindows: Array<{ windowId: string | null; ts: number }> = [];
let lastLlmTags: string[] = [];
let lastTextResult: TextEmotionResult | null = null;
let lastAnalysisConfidence = 0;
let lastAnalysisHits = 0;
let lastAnalysisAt = 0;
let analysisGeneration = 0;
let pendingText: { windowId: string | null; generation: number } | null = null;
let textAnalysis: NonNullable<StatusResponse['text_analysis']> = { source: 'dictionary', status: 'idle' };
let manualMood: { emotion: EmotionVector; until: number } | null = null;
const lastPlayedAt = new Map<string, number>();
let inactiveSince: number | null = null;
let manualStop = false;
let autoPausedByUs = false;
let currentTrack: { id: string; artist: string; matchScore: number; attribution: Attribution; sustained?: boolean } | null = null;
let playbackIntent = 0; // Manual pause invalidates work already waiting on network/audio.
let pausePending = false;

async function dispatchAudioJobs(): Promise<void> {
  const settings = await settingsRepo.get();
  if (settings.plugin_enabled && settings.song_audio_enabled && settings.song_audio_key &&
    await db.audioJobs.where('status').anyOf('queued', 'processing').count()) await wakeAudioWorker();
}

// Serialized state changes prevent heartbeats, UI and ended events from racing.
let ready: Promise<void> = Promise.resolve();
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(() => ready).then(fn);
  queue = next.catch(e => logger.warn('[scheduler]', e));
  return next;
}

async function saveSession(): Promise<void> {
  await browser.storage.session.set({ scheduler: {
    lastPlayedAt: [...lastPlayedAt], inactiveSince,
    manualStop, autoPausedByUs, currentTrack, manualMood,
    lastPlayback,
  } });
}

async function restoreSession(): Promise<void> {
  await feedbackTracker.hydrate();
  const { scheduler } = await browser.storage.session.get('scheduler');
  const s = scheduler as {
    lastPlayedAt?: [string, number][];
    inactiveSince?: number; manualStop?: boolean; autoPausedByUs?: boolean;
    currentTrack?: typeof currentTrack; manualMood?: typeof manualMood;
    lastPlayback?: PlaybackState;
  } | undefined;
  if (s) {
    for (const [id, at] of s.lastPlayedAt ?? []) if (Date.now() - at < 86_400_000) lastPlayedAt.set(id, at);
    inactiveSince = s.inactiveSince ?? null;
    manualStop = s.manualStop ?? false;
    autoPausedByUs = s.autoPausedByUs ?? false;
    currentTrack = s.currentTrack ?? null;
    manualMood = s.manualMood && isEmotionVector(s.manualMood.emotion) && s.manualMood.until > Date.now() ? s.manualMood : null;
    lastPlayback = s.lastPlayback ?? lastPlayback;
  }
  await reconcilePlayback();
}

async function reconcilePlayback(): Promise<void> {
  const live = await getOffscreenPlaybackState();
  if (live) lastPlayback = live;
  else if (lastPlayback.status === 'playing') {
    // AUDIO_PLAYBACK documents may be reclaimed after 30s silence (including zero volume).
    // Preserve the last known position; focused reading will recreate the player.
    lastPlayback = { ...lastPlayback, status: 'paused' };
    autoPausedByUs = !manualStop;
  }
}

async function resumePlayback(): Promise<boolean> {
  if (pausePending) return false;
  const intent = playbackIntent;
  const live = await getOffscreenPlaybackState();
  if (intent !== playbackIntent) return false;
  if (live?.trackId === lastPlayback.trackId && live?.status !== 'stopped') {
    const result = await resumeInOffscreen();
    if (intent !== playbackIntent) return false;
    lastPlayback = result.state;
    return result.ok;
  }
  const settings = await settingsRepo.get();
  const reading = await getActiveReading();
  const result = await select(settings, reading);
  if (intent !== playbackIntent) return false;
  const candidate = result.ranked.find(r => r.candidate.id === lastPlayback.trackId)?.candidate;
  if (!candidate || feedbackTracker.blacklist().has(candidate.id)) return playCandidates(result, settings, reading);
  const resolved = candidate.source === 'builtin' ? { url: candidate.url } :
    await routePlayableUrl(candidate.id);
  if (intent !== playbackIntent) return false;
  if (!resolved?.url) return playCandidates(result, settings, reading);
  const resumed = await playInOffscreen({ url: resolved.url, trackId: candidate.id, title: candidate.title,
    volume: settings.base_volume, fadeInMs: settings.fade_in_ms, positionSec: lastPlayback.positionSec });
  if (intent !== playbackIntent) return false;
  lastPlayback = resumed.state;
  return resumed.ok; // Same listening session: no second play_start or new attribution.
}

function attribution(reading?: ReadingState | null): Attribution {
  return { windowId: reading?.window_id ?? null,
    sceneBucket: sceneBucket(currentEmotion, reading?.extractor.startsWith('weread') ? 'novel' : 'article'),
    features: { state: reading?.state ?? 'inactive', cpm: reading?.reading_speed_cpm ?? 0 } };
}

async function runSyncAndTag(): Promise<void> {
  try {
    const settings = await settingsRepo.get();
    if (!settings.netease_enabled || !settings.enabled_sources.includes('netease')) return;
    await syncMusicLibrary(settings.netease_search_supplement);
    await runTagBatch();
  } catch (e) { logger.warn('[sync]', e); }
}

async function runTagBatch(): Promise<void> {
  if (tagging) return;
  tagging = true;
  try {
    const settings = await settingsRepo.get();
    if (!settings.plugin_enabled || !settings.netease_enabled || !settings.enabled_sources.includes('netease')) return;
    // 文字任务分配的模型只分析阅读文本；歌曲模型调用统一走显式音频任务。
    const metadataSettings = { ...settings, llm_endpoint: '', llm_key: '', embedding_model: '' };
    const pending = await songsRepo.listPendingTag(20, false, TAG_VERSION, candidatePriority);
    if (pending.length < 20) {
      const recovery = await db.songs.filter(s => !s.blacklisted && !s.playable &&
        Date.now() - (s.last_probe_at ?? 0) > 3600_000 &&
        !pending.some(p => p.song_id === s.song_id)).limit(20 - pending.length).toArray();
      pending.push(...recovery);
    }
    for (const song of pending) {
      try {
        if (!song.playable || song.url_expire_at <= Date.now()) await probeSong(song.song_id);
        await tagSong(await songsRepo.get(song.song_id) ?? song, metadataSettings);
      } catch (e) { logger.warn('[tag]', e); }
    }
    await refreshPopularity();
  } finally { tagging = false; }
}

async function getActiveReading(): Promise<ReadingState | null> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  // 无阅读心跳的标签页（含Popup/设置页）只表示暂时离开阅读。
  // 不依赖tabs权限才能读取的URL，保留最近阅读画像供Popup检查。
  if (tab?.id == null || !readingByTab.has(tab.id)) return null;
  if (tab?.id !== activeTabId) {
    activeTabId = tab?.id ?? null;
    currentEmotion = manualMood?.until && manualMood.until > Date.now() ? manualMood.emotion : null;
    analyzedWindows = [];
    lastLlmTags = [];
    lastTextResult = null;
    analysisGeneration++;
    pendingText = null;
    textAnalysis = { ...textAnalysis, status: 'idle', error: undefined };
    lastAnalysisAt = 0;
  }
  const reading = tab?.id != null ? readingByTab.get(tab.id) : null;
  return reading && Date.now() - reading.updated_at < 6000 ? reading : null;
}

async function select(settings: Settings, reading: ReadingState | null, currentId = lastPlayback.trackId,
  excludeCurrent = false): Promise<SelectResult> {
  const sourceStatus = await getSourceStatus();
  const result = await selectSongs({
    target: currentEmotion ?? NEUTRAL, llmSceneTags: lastLlmTags, settings,
    feedback: feedbackTracker.toContext(attribution(reading).sceneBucket),
    lastPlayedAt, currentTrackId: currentId, excludeCurrent,
    externalEnabled: settings.netease_enabled && settings.enabled_sources.includes('netease'),
    neteaseConnected: sourceStatus?.state === 'connected',
    blacklist: feedbackTracker.blacklist(), eventCount: await eventsRepo.totalCount(), now: Date.now(),
    context: { embedding: lastTextResult?.embedding, embeddingModel: lastTextResult?.embeddingModel,
      state: reading?.state, cpm: reading?.reading_speed_cpm,
      contentType: reading?.extractor.startsWith('weread') ? 'novel' : 'article' },
  });
  candidatePriority = result.ranked.filter(r => r.candidate.source !== 'builtin').slice(0, 20).map(r => r.candidate.id);
  return result;
}

async function startTrack(ranked: RankedCandidate, settings: Settings,
  reading: ReadingState | null, hardCut = false, externalDeadline = Date.now() + 5000): Promise<boolean> {
  if (pausePending) return false;
  const intent = playbackIntent;
  const candidate = ranked.candidate;
  if (feedbackTracker.blacklist().has(candidate.id)) return false;
  const song = candidate.source === 'builtin' ? null : await songsRepo.get(candidate.id);
  const budget = () => Math.max(0, externalDeadline - Date.now());
  const backups = () => withinDeadline(signal => resolveBackupUrls(candidate.id, signal), budget(), []);
  const resolved = candidate.source === 'builtin' ? { url: candidate.url } :
    await routePlayableUrl(candidate.id, Math.min(2500, budget()));
  const urls = resolved?.url ? [resolved.url] : [];
  if (intent !== playbackIntent) return false;
  let triedBackups = !resolved?.url;
  for (const url of urls) {
    if (intent !== playbackIntent) return false;
    if (song && Date.now() >= externalDeadline) break;
    try {
      const result = await playInOffscreen({ url, trackId: candidate.id, title: candidate.title,
        volume: settings.base_volume, fadeInMs: settings.fade_in_ms, fadeOutMs: settings.fade_out_ms, hardCut,
        startDeadline: song ? Math.min(Date.now() + 1500, externalDeadline) : undefined });
      if (intent !== playbackIntent) return false;
      lastPlayback = result.state;
      if (!result.ok) {
        if (result.state.blocked) return false;
        if (song) {
          await songsRepo.markLoadFailure(candidate.id);
          await invalidatePlayableUrl(candidate.id);
          if (!triedBackups) {
            triedBackups = true;
            urls.push(...(await backups()).filter(u => !urls.includes(u)).slice(0, 2));
          }
        }
        continue;
      }
      const now = Date.now();
      lastPlayedAt.set(candidate.id, now);
      autoPausedByUs = false;
      const context = attribution(reading);
      context.decision = ranked.snapshot;
      context.features = { ...context.features, artist: candidate.artist, tags: candidate.tags.join('|'), bpm: candidate.bpm,
        preference_keys: preferenceKeys(candidate).join('|') };
      currentTrack = { id: candidate.id, artist: candidate.artist, matchScore: ranked.finalScore, attribution: context };
      // Persist playback/session before non-critical analytics.
      await saveSession();
      await feedbackTracker.recordPlay(candidate.id, candidate.artist, context);
      if (song) await songsRepo.markPlayed(candidate.id, url, now);
      return true;
    } catch (e) { logger.warn('[play]', e); }
  }
  // Metadata timeout/queue expiry is not a measured media-load failure.
  return false;
}

async function playCandidates(result: SelectResult, settings: Settings, reading: ReadingState | null,
  hardCut = false): Promise<boolean> {
  if (pausePending) return false;
  const intent = playbackIntent;
  // Share one foreground budget across external candidates; audio acknowledges
  // cancellation before the local fallback is started.
  const externalDeadline = Date.now() + 5000;
  for (const ranked of result.targets) {
    if (intent !== playbackIntent) return false;
    if (ranked.candidate.source !== 'builtin' && Date.now() >= externalDeadline) continue;
    try { if (await startTrack(ranked, settings, reading, hardCut, externalDeadline)) return true; }
    catch (e) { logger.warn('[candidate fallback]', e); }
    if (lastPlayback.blocked) break;
  }
  if (!lastPlayback.blocked) {
    if (intent !== playbackIntent) return false;
    const attempted = new Set(result.targets.map(r => r.candidate.id));
    for (const ranked of result.ranked) {
      if (intent !== playbackIntent) return false;
      if (ranked.candidate.source !== 'builtin' || ranked.candidate.id === currentTrack?.id || attempted.has(ranked.candidate.id)) continue;
      if (await startTrack(ranked, settings, reading, hardCut)) return true;
    }
  }
  return false;
}

async function evaluateAuto(reading: ReadingState | null, newAnalysis = false): Promise<void> {
  const settings = await settingsRepo.get();
  if (!settings.plugin_enabled) return;
  const now = Date.now();
  if (currentTrack && !currentTrack.sustained && lastPlayback.status === 'playing' &&
    (lastPlayback.positionSec ?? 0) >= 60) {
    await feedbackTracker.recordSustainedPlay(currentTrack.id, currentTrack.attribution);
    currentTrack.sustained = true;
    await saveSession();
  }
  // Scanning remains active reading. Only inactive/stale tabs start the idle timer.
  const active = reading != null && reading.state !== 'inactive' && reading.page_active;
  if (active) inactiveSince = null;
  else if (inactiveSince == null) {
    const last = activeTabId != null ? readingByTab.get(activeTabId) : null;
    inactiveSince = last && last.state !== 'inactive' ? Math.min(now, last.updated_at + 6000) : now;
  }
  // One-shot deadline survives worker suspension. The periodic alarm remains a recovery watchdog.
  if (settings.auto_pause && lastPlayback.status === 'playing' &&
    (active || (inactiveSince != null && now - inactiveSince < 30_000))) {
    await browser.alarms.create(IDLE_DEADLINE, { when: active ? now + 36_000 : inactiveSince! + 30_000 });
  }
  if (settings.auto_pause && lastPlayback.status === 'playing' &&
    inactiveSince != null && now - inactiveSince >= 30_000) {
    const result = await pauseInOffscreen();
    lastPlayback = result.state;
    autoPausedByUs = result.ok && result.state.status === 'paused';
    await saveSession();
    return;
  }
  await saveSession();
  if (reading?.state !== 'focused' || !settings.autoplay || manualStop || lastPlayback.blocked) return;
  if (lastPlayback.status === 'paused' && autoPausedByUs) {
    if (await resumePlayback()) autoPausedByUs = false;
    await saveSession();
    return;
  }
  if (lastPlayback.status === 'stopped') {
    await playCandidates(await select(settings, reading, null), settings, reading);
  } else if (lastPlayback.status === 'playing' && newAnalysis) {
    const result = await select(settings, reading);
    if (!result.best || result.best.candidate.id === lastPlayback.trackId ||
      !(currentEmotion?.some(n => n > 0))) return;
    if (await playCandidates(result, settings, reading)) feedbackTracker.noteSwitch();
  }
}

async function switchManually(dislike = false): Promise<void> {
  const settings = await settingsRepo.get();
  const reading = await getActiveReading();
  const previous = currentTrack;
  const elapsed = (lastPlayback.positionSec ?? 0) * 1000;
  const changed = await playCandidates(await select(settings, reading, lastPlayback.trackId, true), settings, reading, true);
  if (changed) {
    manualStop = false;
    if (!dislike && previous) await feedbackTracker.recordManualSwitch(previous.id, previous.attribution, elapsed);
  } else if (dislike) {
    lastPlayback = (await pauseInOffscreen()).state;
    manualStop = true;
  }
  await saveSession();
}

async function buildMoodDebug(settings: Settings, reading: ReadingState | null): Promise<MoodDebugInfo | null> {
  if (!currentEmotion) return null;
  const result = await select(settings, reading);
  return { vector: currentEmotion,
    confidence: lastAnalysisConfidence, hit_count: lastAnalysisHits,
    top_title: result.best?.candidate.title ?? null, top_score: result.best && currentEmotion.some(n => n > 0) ?
      Math.round(result.best.finalScore) : null };
}

async function buildDashboardStats(): Promise<DashboardStats> {
  const [external, tagged, events, dislikes, recent] = await Promise.all([
    songsRepo.count(), profilesRepo.count(), eventsRepo.totalCount(), eventsRepo.dislikeCount(),
    eventsRepo.recentActions(90 * 24 * 3600_000),
  ]);
  const tally = eventsRepo.tally(recent.map(e => e.action));
  return { external_count: external, tagged_count: tagged, event_count: events,
    complete_rate: tally.plays ? Math.min(100, Math.round(tally.completes / tally.plays * 100)) : 0,
    dislike_count: dislikes, switch_count: tally.manualSwitches };
}

async function buildStatus(): Promise<StatusResponse> {
  const settings = await settingsRepo.get();
  const state = await getOffscreenPlaybackState();
  if (state) lastPlayback = state;
  const reading = await getActiveReading();
  const persisted = await navigator.storage?.persisted?.().catch(() => false) ?? false;
  const unlimited = await browser.permissions?.contains({ permissions: ['unlimitedStorage'] }).catch(() => false) ?? false;
  return { ok: true, persisted, storage_protected: persisted || unlimited,
    cc0Count: CC0_TRACKS.length, playback: lastPlayback, reading,
    mood: await buildMoodDebug(settings, reading), enabled: settings.plugin_enabled,
    stats: await buildDashboardStats(), llm_ready: isLlmConfigured(settings), syncing: isSyncing(),
    text_analysis: { ...textAnalysis, source: isLlmConfigured(settings) ? 'model' : 'dictionary' },
    manual_mood_until: manualMood?.until ?? 0,
    source_status: await getSourceStatus() };
}

async function disable(): Promise<void> {
  const s = await settingsRepo.get();
  if (s.plugin_enabled) {
    await feedbackTracker.recordClosePlugin(currentTrack?.id, currentTrack?.attribution);
    await settingsRepo.update({ plugin_enabled: false,
      vocal_penalty: Math.min(.5, s.vocal_penalty + .05) });
  }
  analysisGeneration++;
  lastPlayback = (await pauseInOffscreen()).state;
  manualStop = true;
  autoPausedByUs = false;
}

async function handleMessage(msg: BackgroundMessage): Promise<unknown> {
  await reconcilePlayback();
  switch (msg.type) {
    case 'GET_STATUS': return buildStatus();
    case 'PLAY': {
      if (msg.trackId === lastPlayback.trackId && lastPlayback.status !== 'stopped') {
        await resumePlayback();
        manualStop = false;
        break;
      }
      const settings = await settingsRepo.get();
      const reading = await getActiveReading();
      const result = await select(settings, reading, null);
      const ranked = result.ranked.find(r => r.candidate.id === msg.trackId);
      const previous = currentTrack;
      const elapsed = (lastPlayback.positionSec ?? 0) * 1000;
      if (ranked && await startTrack(ranked, settings, reading, true)) {
        manualStop = false;
        if (previous && previous.id !== msg.trackId)
          await feedbackTracker.recordManualSwitch(previous.id, previous.attribution, elapsed);
      }
      break;
    }
    case 'NEXT_TRACK': await switchManually(); break;
    case 'PAUSE':
      manualStop = true;
      autoPausedByUs = false;
      lastPlayback = (await pauseInOffscreen()).state;
      break;
    case 'RESUME':
      manualStop = false;
      autoPausedByUs = false;
      if (lastPlayback.trackId && !feedbackTracker.blacklist().has(lastPlayback.trackId)) {
        await resumePlayback();
      } else await switchManually();
      break;
    case 'SET_VOLUME': {
      const volume = Math.max(0, Math.min(100, Math.round(msg.volume)));
      await settingsRepo.update({ base_volume: volume });
      await setVolumeInOffscreen(volume);
      break;
    }
    case 'LIKE_TRACK':
      await feedbackTracker.recordLike(msg.trackId, currentTrack?.id === msg.trackId ?
        currentTrack.attribution : attribution(await getActiveReading()));
      break;
    case 'DISLIKE_TRACK':
      await feedbackTracker.recordDislike(msg.trackId, currentTrack?.id === msg.trackId ?
        currentTrack.attribution : attribution(await getActiveReading()));
      if (lastPlayback.trackId === msg.trackId) await switchManually(true);
      break;
    case 'SET_ENABLED':
      if (msg.enabled) {
        await settingsRepo.update({ plugin_enabled: true });
        manualStop = false;
        await evaluateAuto(await getActiveReading());
      } else await disable();
      break;
    case 'SET_MOOD':
      if (msg.emotion !== null && !isEmotionVector(msg.emotion)) return { ok: false, error: '情绪必须是八维0～1分数' };
      manualMood = msg.emotion ? { emotion: msg.emotion, until: Date.now() + 600_000 } : null;
      currentEmotion = msg.emotion;
      lastLlmTags = [];
      lastTextResult = null;
      analyzedWindows = [];
      analysisGeneration++;
      lastAnalysisAt = 0;
      if (msg.emotion) await switchManually();
      break;
    case 'UPDATE_SETTINGS': {
      const previousSettings = await settingsRepo.get();
      if (msg.patch.plugin_enabled === false) await disable();
      const updatedSettings = await settingsRepo.update(msg.patch);
      if (!updatedSettings.plugin_enabled || ([
        'song_audio_enabled', 'song_audio_endpoint', 'song_audio_key', 'song_audio_model',
      ] as const).some(key => previousSettings[key] !== updatedSettings[key]))
        await cancelAudioWorker();
      if (!previousSettings.plugin_enabled && updatedSettings.plugin_enabled) manualStop = false;
      if (msg.patch.base_volume != null) await setVolumeInOffscreen(updatedSettings.base_volume);
      analysisGeneration++;
      lastAnalysisAt = 0;
      analyzedWindows = [];
      pendingText = null;
      textAnalysis = { source: isLlmConfigured(updatedSettings) ? 'model' : 'dictionary', status: 'idle' };
      // Consumers re-read settings without leaking the BYOK key into pages.
      lastTextResult = null;
      lastLlmTags = [];
      for (const tabId of readingByTab.keys())
        void browser.tabs.sendMessage(tabId, { type: 'SETTINGS_CHANGED' }).catch(() => {});
      break;
    }
    case 'SYNC_MUSIC': void runSyncAndTag(); break;
    case 'GET_BALL_STATE': {
      const settings = await settingsRepo.get();
      return { visible: settings.floating_ball, enabled: settings.plugin_enabled,
        playback: lastPlayback,
        readingSettings: { window_size: settings.window_size, update_interval_sec: settings.update_interval_sec } };
    }
    default: return;
  }
  await saveSession();
  return buildStatus();
}

function rememberAnalyzedWindow(state: ReadingState): void {
  const now = Date.now();
  analyzedWindows = analyzedWindows.filter(w => now - w.ts < 300_000 && w.windowId !== state.window_id);
  analyzedWindows.push({ ts: now, windowId: state.window_id });
  analyzedWindows = analyzedWindows.slice(-8);
}

function commitEmotion(emotion: EmotionVector, state: ReadingState): void {
  currentEmotion = emotion;
  rememberAnalyzedWindow(state);
}

async function heartbeat(state: ReadingState, tabId: number): Promise<void> {
  let newAnalysis = false;
  const text = state.visible_text;
  const stored = { ...state };
  delete stored.visible_text;
  readingByTab.set(tabId, stored);
  const reading = await getActiveReading();
  if (tabId !== activeTabId) return;
  await reconcilePlayback();
  const settings = await settingsRepo.get();
  if (!settings.plugin_enabled) return;
  if (manualMood && manualMood.until <= Date.now()) { manualMood = null; lastAnalysisAt = 0; }
  if (manualMood) currentEmotion = manualMood.emotion;
  if (text && reading?.state === 'focused' && !manualMood &&
    Date.now() - lastAnalysisAt >= settings.update_interval_sec * 1000 &&
    !(pendingText?.windowId === state.window_id && pendingText.generation === analysisGeneration) &&
    !analyzedWindows.some(w => w.windowId === state.window_id)) {
    lastAnalysisAt = Date.now();
    const generation = ++analysisGeneration;
    const started = performance.now();
    if (isLlmConfigured(settings)) {
      pendingText = { windowId: state.window_id, generation };
      textAnalysis = { source: 'model', status: 'pending' };
      const complete = (llm: TextEmotionResult | null, error?: string) => enqueue(async () => {
        const active = await getActiveReading();
        if (pendingText?.generation === generation) pendingText = null;
        if (generation !== analysisGeneration || activeTabId !== tabId || manualMood ||
          !(await settingsRepo.get()).plugin_enabled || active?.window_id !== state.window_id) return;
        if (llm) {
          lastLlmTags = llm.sceneTags;
          lastTextResult = llm;
          lastAnalysisConfidence = llm.confidence;
          lastAnalysisHits = 0;
          commitEmotion(llm.emotion, state);
          textAnalysis = { source: 'model', status: 'complete' };
        } else {
          rememberAnalyzedWindow(state);
          textAnalysis = { source: 'model', status: 'failed', error: error ?? '文字模型识别失败' };
        }
        await readingAnalysisRepo.record(state, tabId, {
          trackId: lastPlayback.trackId, title: lastPlayback.title,
        }, { profile: null, elapsedMs: performance.now() - started,
          result: llm ? await select(settings, active) : undefined,
          vector: llm?.emotion ?? null, source: 'model', model: settings.llm_model,
          evidence: llm?.evidence, error: llm ? undefined : textAnalysis.error })
          .catch(e => logger.warn('[reading-analysis]', e));
        if (llm) await evaluateAuto(active, true);
      });
      // 网络在播放调度队列之外执行。过期窗口/配置的响应不能改变当前情绪。
      void analyzeTextWithLlm(text, `${tabId}:${state.window_id}`, settings)
        .then(llm => complete(llm), error => complete(null, error instanceof Error ? error.message : '文字模型识别失败'))
        .catch(e => logger.warn('[understanding]', e));
    } else {
      newAnalysis = true;
      const profile = scoreTextEmotions(text);
      commitEmotion(profile.vector, state);
      lastAnalysisConfidence = Math.min(1, profile.matchedExpressionCount / 5);
      lastAnalysisHits = profile.matchedExpressionCount;
      lastLlmTags = [];
      lastTextResult = null;
      textAnalysis = { source: 'dictionary', status: 'complete' };
      await readingAnalysisRepo.record(state, tabId, {
        trackId: lastPlayback.trackId, title: lastPlayback.title,
      }, { profile, elapsedMs: performance.now() - started, result: await select(settings, reading),
        vector: profile.vector, source: 'dictionary' }).catch(e => logger.warn('[reading-analysis]', e));
    }
  }
  await evaluateAuto(reading, newAnalysis);
}

export default defineBackground(() => {
  ready = restoreSession().catch(e => logger.warn('[restore]', e));
  void navigator.storage?.persist?.().catch(() => false);
  const schedule = async () => {
    if (!await browser.alarms.get(SYNC_ALARM)) await browser.alarms.create(SYNC_ALARM, { periodInMinutes: 60 });
    if (!await browser.alarms.get(IDLE_ALARM)) await browser.alarms.create(IDLE_ALARM, { periodInMinutes: .5 });
    if (!await browser.alarms.get(TAG_ALARM)) await browser.alarms.create(TAG_ALARM, { periodInMinutes: 1 });
    if (!await browser.alarms.get(CLEANUP_ALARM)) await browser.alarms.create(CLEANUP_ALARM, { periodInMinutes: 1440 });
  };
  void schedule().catch(e => logger.warn('[alarms]', e));
  void reinjectOpenWereadTabs()
    .then(count => { if (count) logger.info(`[reinject] 已恢复 ${count} 个微信读书标签页`); })
    .catch(e => logger.warn('[reinject] 扫描已打开阅读页失败', e));
  const catchUp = async () => {
    await songsRepo.prune();
    await refreshPopularity();
    const status = await getSourceStatus();
    if (!status?.last_sync || Date.now() - status.last_sync >= 3600_000) await runSyncAndTag();
    else await runTagBatch();
  };
  browser.runtime.onStartup.addListener(() => { void catchUp().catch(e => logger.warn('[startup]', e)); });
  browser.runtime.onInstalled.addListener(() => { void catchUp().catch(e => logger.warn('[install]', e)); });
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === TAG_ALARM) void dispatchAudioJobs().catch(() => logger.warn('[audio-tag] 唤醒失败'));
    if (alarm.name === SYNC_ALARM) void runSyncAndTag();
    if (alarm.name === TAG_ALARM) void runTagBatch().catch(e => logger.warn('[tag batch]', e));
    if (alarm.name === CLEANUP_ALARM) void songsRepo.prune().then(() => refreshPopularity()).catch(e => logger.warn('[cleanup]', e));
    if (alarm.name === IDLE_ALARM || alarm.name === IDLE_DEADLINE) void enqueue(async () => {
      await reconcilePlayback();
      await evaluateAuto(await getActiveReading());
    });
  });
  browser.tabs.onRemoved.addListener(tabId => {
    readingByTab.delete(tabId);
    if (tabId === activeTabId) void enqueue(async () => { await evaluateAuto(await getActiveReading()); });
  });
  browser.tabs.onActivated.addListener(() => { void enqueue(async () => { await evaluateAuto(await getActiveReading()); }); });
  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
    const type = String(raw.type);
    // Explicit callback works across Chrome versions and keeps asynchronous ports open.
    const respond = (work: Promise<unknown>) => {
      work.then(sendResponse, () => sendResponse({ ok: false, error: '操作失败，请重试' }));
      return true as const;
    };
    if (type === 'AUDIO_TAG_START') {
      return respond((async () => {
        try {
          const songId = (raw as { songId?: string }).songId;
          const result = await enqueueAudioJobs(songId);
          await dispatchAudioJobs();
          return { ok: true, ...result };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : '听感识别任务启动失败' };
        }
      })());
    }
    if (type === 'AUDIO_TAG_RESOLVE') {
      return respond((async () => {
        const request = raw as unknown as { songId: string; requestId: string };
        const job = await db.audioJobs.get(request.songId);
        if (job?.status !== 'processing' || job.request_id !== request.requestId) return null;
        return resolvePlayableUrl(request.songId, AbortSignal.timeout(15_000));
      })());
    }
    if (type === 'OFFSCREEN_AUDIO_PROGRESS') {
      sendResponse({ ok: true });
      return;
    }
    if (type === 'PAUSE') {
      // Bypass the decision queue: its head may be awaiting the audio start that
      // this very pause needs to cancel. Stale work checks playbackIntent.
      playbackIntent++;
      pausePending = true;
      manualStop = true;
      const paused = (async () => {
        await ready;
        manualStop = true;
        autoPausedByUs = false;
        lastPlayback = (await pauseInOffscreen()).state;
        await saveSession();
        return buildStatus();
      })();
      void enqueue(async () => {
        await paused;
        pausePending = false;
        manualStop = true;
        await saveSession();
      }).catch(() => { pausePending = false; });
      return respond(paused);
    }
    // Do not enqueue audio broadcasts: a playback command may be awaiting its ack.
    if (type.startsWith('OFFSCREEN_')) {
      if (type === 'OFFSCREEN_AUDIO_FEATURES') {
        const event = raw as unknown as { trackId: string; features: SongProfile['audio_features'] };
        return respond(enqueue(async () => {
          const song = await songsRepo.get(event.trackId);
          const profile = await profilesRepo.get(event.trackId);
          if (!song || !profile) return;
          profile.audio_features = event.features;
          profile.audio_analysis_status = event.features ? 'complete' : 'unavailable';
          await profilesRepo.upsert(fuseSongProfile(song, profile, song.profile_status === 'llm_done'));
          if (currentTrack?.id === event.trackId && event.features) {
            currentTrack.attribution.features = { ...currentTrack.attribution.features,
              preference_keys: preferenceKeys({ bpm: event.features.bpm, vocalDensity: event.features.vocal_density,
                energyCurve: event.features.energy_curve, spectralCentroidHz: event.features.spectral_centroid_hz,
                hasLyrics: song.has_lyrics }).join('|') };
            await saveSession();
          }
        }));
      }
      if (type === 'OFFSCREEN_ENDED' || type === 'OFFSCREEN_FAILED') {
        const event = raw as { type: string; trackId: string };
        return respond(enqueue(async () => {
          if (currentTrack?.id !== event.trackId) return;
          if (event.type === 'OFFSCREEN_ENDED') await feedbackTracker.recordFullPlay(event.trackId, currentTrack.attribution);
          else await songsRepo.markLoadFailure(event.trackId);
          currentTrack = null;
          lastPlayback = await getOffscreenPlaybackState() ?? { ...lastPlayback, status: 'stopped' };
          await saveSession();
          const reading = await getActiveReading();
          const settings = await settingsRepo.get();
          // A natural end or failed stream must also continue during scanning.
          if (settings.plugin_enabled && !manualStop && reading?.page_active && reading.state !== 'inactive')
            await playCandidates(await select(settings, reading, event.trackId, true), settings, reading);
          else await evaluateAuto(reading);
        }));
      }
      return;
    }
    if (type === 'READING_HEARTBEAT') {
      const state = (raw as unknown as { state: ReadingState }).state;
      if (sender.tab?.id != null) return respond(enqueue(() => heartbeat(state, sender.tab!.id!)));
      return;
    }
    return respond(enqueue(() => handleMessage(raw as BackgroundMessage)));
  });
});
