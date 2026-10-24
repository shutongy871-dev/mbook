import { browser } from 'wxt/browser';
import { isExtensionContextError } from '@/core/shared/errors';
import { logger } from '@/core/shared/logger';
import type {
  ReadingHeartbeatMessage,
  ReadingState,
  Settings,
} from '@/core/shared/contracts';
import { extractReadingContent, type ExtractedContent } from './extractors';
import { judgeReadingState } from './reading-state';
import { buildWindowId } from './windowing';

// 运行在内容脚本（isolated world）里：贴在每个网页上的"阅读传感器"
// 职责：感知停留 / 滚动 / 可见段落 / 章节切换，算出三态，心跳上报给 SW
// 不做：情绪理解、切歌决策、正文入库

const TICK_MS = 1000; // 每秒采样一次
const HEARTBEAT_MS = 2000; // 每 2 秒上报一次
const CPM_WINDOW_MS = 60_000; // 阅读速度取近 60 秒滑动窗口
const CPM_MIN_SPAN_MS = 3000; // 窗口太短不算速度
const REEXTRACT_INTERVAL_TICKS = 5; // 每 5 秒体检一次 DOM 是否被站点重渲染

export class ReadingCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private observer: IntersectionObserver | null = null;
  private elToIndex = new Map<Element, number>();

  private content: ExtractedContent | null = null;
  private lens: number[] = [];
  private prefixSum: number[] = [0];
  private visibleSet = new Set<number>();

  private url = '';
  private host = '';
  private chapterKey = '';
  private pageActive = true;
  private staySec = 0;
  private lastScrollY = 0;
  private scrollPositions = new Map<Element, { x: number; y: number }>();
  private innerScrollDistance = 0;
  private scrollSpeedEma = 0;
  private maxReadIndex = -1;
  private cpmSamples: Array<{ t: number; consumed: number }> = [];

  private lastHeartbeatAt = 0;
  private lastStateName: string | null = null;
  private tickCount = 0;
  private stopped = false;
  private lastTickAt = 0;
  private speedKnown = false;
  private textIntervalMs = 6000;
  private textMaxChars = 300;
  private enabled = true;
  private mutationObserver: MutationObserver | null = null;
  private dirty = false;

  configure(settings: Partial<Settings>): void {
    if (settings.window_size != null) this.textMaxChars = Math.max(150, Math.min(600, settings.window_size));
    if (settings.update_interval_sec != null) this.textIntervalMs = Math.max(3, Math.min(15, settings.update_interval_sec)) * 1000;
    if (settings.plugin_enabled != null) this.enabled = settings.plugin_enabled;
  }

  invalidateContent(): void { this.dirty = true; }

  // 正文片段节流：仅 focused 且（阅读窗口变化 OR 距上次 ≥6s）时随心跳携带
  private lastTextAt = 0;
  private lastTextWindowId: string | null = null;

  start(): void {
    this.stopped = false;
    this.lastTickAt = Date.now();
    this.url = location.href;
    this.host = location.hostname;
    this.pageActive = document.visibilityState === 'visible';
    this.lastScrollY = window.scrollY;
    this.reextract();

    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('scroll', this.onScroll, true);
    this.mutationObserver = new MutationObserver((records) => {
      if (records.some((r) => !(r.target instanceof Element && r.target.closest('#mbook-floating-ball')))) this.dirty = true;
    });
    this.mutationObserver.observe(document.body ?? document.documentElement, { childList: true, characterData: true, subtree: true });
    this.timer = setInterval(this.tick, TICK_MS);
    logger.info('[content] 阅读采集器已启动:', this.host);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.observer?.disconnect();
    this.mutationObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('scroll', this.onScroll, true);
    this.scrollPositions.clear();
  }

  private onScroll = (event: Event): void => {
    const el = event.target;
    if (!(el instanceof Element) || el === document.scrollingElement) return;
    const prev = this.scrollPositions.get(el);
    if (prev) this.innerScrollDistance += Math.hypot(el.scrollLeft - prev.x, el.scrollTop - prev.y);
    this.scrollPositions.set(el, { x: el.scrollLeft, y: el.scrollTop });
  };

  private onVisibility = (): void => {
    this.pageActive = document.visibilityState === 'visible';
    this.staySec = 0;
    this.cpmSamples = [];
    this.speedKnown = false;
    this.lastTickAt = Date.now();
    this.lastScrollY = window.scrollY;
    this.innerScrollDistance = 0;
  };

  private onIntersect = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const idx = this.elToIndex.get(entry.target);
      if (idx == null) continue;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        this.visibleSet.add(idx);
      } else {
        this.visibleSet.delete(idx);
      }
    }
  };

  // 抽取正文并重建观察器；章节切换 / SPA 跳转 / DOM 被重渲染时调用
  private reextract(): void {
    let parsed: URL;
    try { parsed = new URL(location.href); } catch { return; }
    const content = extractReadingContent(parsed, document);
    const chapterKey = `${parsed.origin}${parsed.pathname}${parsed.search}|${content?.chapter ?? ''}`;
    const same = chapterKey === this.chapterKey && content?.paragraphs.length === this.content?.paragraphs.length &&
      content?.paragraphs.every((p, i) => {
        const old = this.content?.paragraphs[i];
        return p.el === old?.el && p.text === old?.text &&
          p.region?.x === old?.region?.x && p.region?.y === old?.region?.y &&
          p.region?.width === old?.region?.width && p.region?.height === old?.region?.height;
      });
    this.dirty = false;
    if (same) return;
    this.observer?.disconnect();
    this.observer = null;
    this.visibleSet.clear();
    this.elToIndex.clear();
    this.cpmSamples = [];
    this.maxReadIndex = -1;
    this.speedKnown = false;
    this.staySec = 0;
    this.lastTextWindowId = null;
    this.content = content;
    this.chapterKey = chapterKey;
    this.scrollPositions.clear();
    this.innerScrollDistance = 0;

    if (content) {
      this.lens = content.paragraphs.map((p) => p.len);
      this.prefixSum = [0];
      for (const p of content.paragraphs) {
        const prev = this.prefixSum[this.prefixSum.length - 1] ?? 0;
        this.prefixSum.push(prev + p.len);
        if (!p.region) this.elToIndex.set(p.el, p.index);
        for (let el = p.el.parentElement; el; el = el.parentElement) {
          if (this.scrollPositions.has(el)) break;
          this.scrollPositions.set(el, { x: el.scrollLeft, y: el.scrollTop });
        }
      }
      if (typeof IntersectionObserver !== 'undefined') {
        this.observer = new IntersectionObserver(this.onIntersect, {
          threshold: [0, 0.5, 1],
        });
        for (const p of content.paragraphs) if (!p.region) this.observer.observe(p.el);
      }
    } else {
      this.lens = [];
      this.prefixSum = [0];
    }
  }

  private consumedChars(): number {
    if (this.maxReadIndex < 0) return 0;
    return this.prefixSum[this.maxReadIndex] ?? 0;
  }

  private computeCpm(now: number): number {
    const samples = this.cpmSamples;
    while (
      samples.length > 2 &&
      now - (samples[0]?.t ?? now) > CPM_WINDOW_MS
    ) {
      samples.shift();
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last) return 0;
    const span = last.t - first.t;
    if (span < CPM_MIN_SPAN_MS) return 0;
    const chars = Math.max(0, last.consumed - first.consumed);
    return Math.round(chars / (span / 60000));
  }

  private updateRegionVisibility(): void {
    // 微信读书滚动模式可能把整章绘制在很长的 Canvas 上。
    // 对文本行应用相同的 50% 可见门槛，不能要求整幅画布露出一半。
    const geometry = new Map<Element, {
      rect: DOMRect; left: number; right: number; top: number; bottom: number;
    }>();
    for (const p of this.content?.paragraphs ?? []) {
      if (!p.region) continue;
      this.visibleSet.delete(p.index);
      if (!p.el.isConnected || !p.el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      let bounds = geometry.get(p.el);
      if (!bounds) {
        bounds = { rect: p.el.getBoundingClientRect(), left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        // 内部滚动容器也会裁切画布；避免把视口内、容器外的行算成可见。
        for (let el = p.el.parentElement; el; el = el.parentElement) {
          const style = window.getComputedStyle?.(el);
          const clipX = style && /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
          const clipY = style && /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
          if (!clipX && !clipY) continue;
          const r = el.getBoundingClientRect();
          if (clipX) {
            bounds.left = Math.max(bounds.left, r.left + el.clientLeft);
            bounds.right = Math.min(bounds.right, r.left + el.clientLeft + el.clientWidth);
          }
          if (clipY) {
            bounds.top = Math.max(bounds.top, r.top + el.clientTop);
            bounds.bottom = Math.min(bounds.bottom, r.top + el.clientTop + el.clientHeight);
          }
        }
        geometry.set(p.el, bounds);
      }
      const { rect, left, top, right, bottom } = bounds;
      const x = rect.left + p.region.x * rect.width;
      const y = rect.top + p.region.y * rect.height;
      const width = p.region.width * rect.width, height = p.region.height * rect.height;
      const visibleWidth = Math.max(0, Math.min(x + width, right) - Math.max(x, left));
      const visibleHeight = Math.max(0, Math.min(y + height, bottom) - Math.max(y, top));
      if (width > 0 && height > 0 && visibleWidth * visibleHeight / (width * height) >= .5) {
        this.visibleSet.add(p.index);
      }
    }
  }

  private tick = (): void => {
    if (this.stopped) return;
    this.tickCount += 1;
    const now = Date.now();
    const elapsedSec = Math.max(0.001, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;

    // SPA 换章不刷新页面：URL 变了就重新抽取
    if (location.href !== this.url) {
      this.url = location.href;
      this.host = location.hostname;
      this.reextract();
    } else if (this.tickCount % REEXTRACT_INTERVAL_TICKS === 0 || (this.host === 'weread.qq.com' && this.dirty)) {
      // 站点重渲染会让旧段落节点脱离文档，体检后重建
      const firstEl = this.content?.paragraphs[0]?.el;
      if (this.dirty || !this.content || (firstEl && !document.contains(firstEl))) this.reextract();
    }

    if (this.pageActive) this.staySec += Math.min(elapsedSec, 2);

    // 滚动速度（屏/秒），EMA 平滑；标签页不可见时归零
    const vh = window.innerHeight || 1;
    const instant = (Math.abs(window.scrollY - this.lastScrollY) + this.innerScrollDistance) / vh / elapsedSec;
    this.lastScrollY = window.scrollY;
    this.innerScrollDistance = 0;
    if (this.pageActive) {
      this.scrollSpeedEma = this.scrollSpeedEma * 0.6 + instant * 0.4;
    } else {
      this.scrollSpeedEma = 0;
    }

    // 可见段落指标
    this.updateRegionVisibility();
    let firstVisible = -1;
    let visibleLen = 0;
    for (const idx of this.visibleSet) {
      if (idx < 0) continue;
      if (firstVisible < 0 || idx < firstVisible) firstVisible = idx;
      visibleLen += this.lens[idx] ?? 0;
    }
    if (firstVisible > this.maxReadIndex) {
      if (this.maxReadIndex >= 0) this.speedKnown = true;
      this.maxReadIndex = firstVisible;
    }

    // 阅读速度：只在页面可见时采样
    if (this.pageActive && this.maxReadIndex >= 0) {
      this.cpmSamples.push({ t: now, consumed: this.consumedChars() });
    }
    const cpm = this.computeCpm(now);

    const judgement = judgeReadingState({
      page_active: this.pageActive && this.enabled,
      stay_sec: this.staySec,
      scroll_speed_sps: this.scrollSpeedEma,
      visible_text_len: visibleLen,
      reading_speed_cpm: cpm,
      reading_speed_known: this.speedKnown,
    });

    const text = this.collectVisibleText();
    const state: ReadingState = {
      url: location.href,
      host: this.host,
      title: document.title,
      extractor: this.content?.extractor ?? 'none',
      chapter: this.content?.chapter ?? null,
      window_id:
        this.content && firstVisible >= 0
          ? buildWindowId(this.chapterKey, firstVisible, text)
          : null,
      state: judgement.state,
      is_reading: judgement.is_reading,
      page_active: this.pageActive,
      stay_sec: Math.round(this.staySec),
      visible_text_len: visibleLen,
      paragraph_count: this.content?.paragraphs.length ?? 0,
      first_visible_index: firstVisible,
      scroll_speed_sps: Math.round(this.scrollSpeedEma * 100) / 100,
      reading_speed_cpm: cpm,
      reading_speed_known: this.speedKnown,
      updated_at: now,
    };

    // 正文片段：T0 情绪词典的输入。仅驻留内存随消息传递，SW 分析完即弃、不入库
    if (judgement.state === 'focused' && this.content && state.window_id != null) {
      const windowChanged = state.window_id !== this.lastTextWindowId;
      if ((windowChanged || now - this.lastTextAt >= this.textIntervalMs) && now - this.lastTextAt >= this.textIntervalMs) {
        state.visible_text = text;
        this.lastTextAt = now;
        this.lastTextWindowId = state.window_id;
      }
    }

    const stateChanged = judgement.state !== this.lastStateName;
    if (stateChanged) this.lastStateName = judgement.state;
    if (stateChanged || state.visible_text != null || now - this.lastHeartbeatAt >= HEARTBEAT_MS) {
      this.lastHeartbeatAt = now;
      this.sendHeartbeat(state);
    }
  };

  // 拼接视口内可见段落正文（按段落顺序），截断到 TEXT_MAX_CHARS
  private collectVisibleText(): string {
    if (!this.content) return '';
    const parts: string[] = [];
    let total = 0;
    const indices = [...this.visibleSet].filter((i) => i >= 0).sort((a, b) => a - b);
    for (const idx of indices) {
      const para = this.content.paragraphs.find((p) => p.index === idx);
      const text = para?.text;
      if (!text) continue;
      parts.push(text);
      total += text.length;
      if (total >= this.textMaxChars) break;
    }
    return parts.join('\n').slice(0, this.textMaxChars);
  }

  private sendHeartbeat(state: ReadingState): void {
    const msg: ReadingHeartbeatMessage = { type: 'READING_HEARTBEAT', state };
    Promise.resolve(browser.runtime.sendMessage(msg)).catch((e: unknown) => {
      // 扩展重载后旧内容脚本通道失效：停止采集，等页面刷新后新脚本接管
      if (isExtensionContextError(e)) {
        logger.debug('[content] 扩展上下文已失效，采集器自停');
        this.stop();
      }
    });
  }
}
