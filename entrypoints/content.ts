import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { ReadingCollector } from '@/core/reading/collector';
import { acceptWereadCanvas, acceptWereadPayload, clearWereadCache } from '@/core/reading/weread-bridge';
import { isExtensionContextError } from '@/core/shared/errors';
import type {
  OffscreenStateMessage,
  PlaybackState,
  Settings,
} from '@/core/shared/contracts';

// 内容脚本入口：所有 http/https 页面注入
// 职责一：阅读采集传感器（Step 2）
// 职责二：网页右下角悬浮球（Step 8）——Shadow DOM 隔离，样式零泄漏到宿主页
export default defineContentScript({
  matches: ['*://*/*'],
  runAt: 'document_idle',
  main(ctx) {
    const collector = new ReadingCollector();
    collector.start();

    let cleanupContent: (stopPageHook: boolean) => void = () => {};
    const ball = new FloatingBall((s) => collector.configure(s), () => cleanupContent(false));
    ball.start();
    const onRuntimeMessage = (message: unknown) => {
      if ((message as { type?: string })?.type === 'MBOOK_CONTENT_PROBE')
        return Promise.resolve({ alive: true });
    };
    browser.runtime.onMessage.addListener(onRuntimeMessage);
    let cleaned = false;
    let lease: ReturnType<typeof setInterval>;
    cleanupContent = (stopPageHook: boolean) => {
      if (cleaned) return;
      cleaned = true;
      collector.stop();
      ball.stop();
      clearInterval(lease);
      clearWereadCache();
      window.removeEventListener('message', onPageMessage);
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
      if (stopPageHook && location.hostname === 'weread.qq.com')
        window.postMessage({ type: 'MBOOK_WEREAD_STOP' }, location.origin);
    };
    const onPageMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (data?.type === 'MBOOK_CONTENT_RESTART') {
        cleanupContent(false);
        return;
      }
      if (location.hostname !== 'weread.qq.com') return;
      if (data?.type === 'MBOOK_WEREAD_CANVAS') {
        if (acceptWereadCanvas(data, location.href)) collector.invalidateContent();
        return;
      }
      if (data?.type !== 'MBOOK_WEREAD_TEXT' || !Array.isArray(data.paragraphs)) return;
      if (data.paragraphs.length > 3000 || data.paragraphs.some((x: unknown) => typeof x !== 'string' || x.length > 250000)) return;
      if (data.paragraphs.join('').length > 250000) return;
      const paragraphs = data.paragraphs.flatMap((text: string) => {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        doc.querySelectorAll('script,style').forEach((el) => el.remove());
        const ps = Array.from(doc.querySelectorAll('p'));
        return ps.length ? ps.map((p) => p.textContent?.trim() ?? '') : [(doc.body.textContent ?? '').trim()];
      });
      if (acceptWereadPayload({ ...data, paragraphs }, location.href)) collector.invalidateContent();
    };
    window.addEventListener('message', onPageMessage);
    if (location.hostname === 'weread.qq.com') {
      if (!document.getElementById('mbook-wake-watchdog')) {
        const script = document.createElement('script');
        script.id = 'mbook-wake-watchdog';
        script.src = browser.runtime.getURL('/wake-watchdog.js');
        (document.head ?? document.documentElement).appendChild(script);
      }
      window.postMessage({ type: 'MBOOK_WEREAD_LEASE' }, location.origin);
    }
    lease = setInterval(() => {
      if (location.hostname === 'weread.qq.com') window.postMessage({ type: 'MBOOK_WEREAD_LEASE' }, location.origin);
    }, 5000);

    // Keep the page-world watchdog alive briefly after an extension reload; it
    // wakes the new worker, which explicitly stops this old hook before reinjection.
    ctx.onInvalidated(() => cleanupContent(false));
  },
});

interface BallStateResponse {
  visible: boolean; // floating_ball 设置
  enabled: boolean; // 插件总开关
  playback: PlaybackState;
  readingSettings?: Partial<Settings>;
}

const BALL_POLL_MS = 4000;

const BALL_SHADOW_HTML = `
<style>
  :host { all: initial; }
  .wrap { display: flex; align-items: center; gap: 8px; }
  .label {
    max-width: 200px; font-size: 12px; color: #e8eaf2;
    background: rgba(29, 31, 43, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 6px 12px; border-radius: 999px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .ball {
    touch-action: none;
    width: 46px; height: 46px; flex: none; border-radius: 50%;
    border: 1px solid rgba(124, 140, 255, 0.55);
    background: rgba(29, 31, 43, 0.94); color: #e8eaf2;
    cursor: pointer; font-size: 20px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    padding: 0;
  }
  .ball.playing {
    border-color: rgba(124, 140, 255, 0.95);
    animation: mbook-pulse 2.2s infinite;
  }
  .ball.paused { opacity: 0.65; }
  @keyframes mbook-pulse {
    0% { box-shadow: 0 0 0 0 rgba(124, 140, 255, 0.45), 0 4px 16px rgba(0,0,0,0.35); }
    70% { box-shadow: 0 0 0 14px rgba(124, 140, 255, 0), 0 4px 16px rgba(0,0,0,0.35); }
    100% { box-shadow: 0 0 0 0 rgba(124, 140, 255, 0), 0 4px 16px rgba(0,0,0,0.35); }
  }
  .hidden { display: none !important; }
</style>
<div class="wrap">
  <span class="label hidden" id="mbook-label"></span>
  <button class="ball hidden" id="mbook-ball" type="button" aria-label="MBook">♪</button>
  <button class="ball hidden" id="mbook-next" type="button" aria-label="换一首" title="换一首">⏭</button>
</div>
`;

class FloatingBall {
  private host: HTMLElement | null = null;
  private ballEl: HTMLButtonElement | null = null;
  private labelEl: HTMLSpanElement | null = null;
  private nextEl: HTMLButtonElement | null = null;
  private dragged = false;
  private point: { x: number; y: number; left: number; top: number } | null = null;
  constructor(private configure: (s: Partial<Settings>) => void,
    private contextInvalidated: () => void) {}
  private timer: ReturnType<typeof setInterval> | null = null;
  private onMsg: ((msg: unknown) => void) | null = null;
  private playback: PlaybackState = {
    status: 'stopped',
    trackId: null,
    title: null,
    volume: 40,
  };
  private visible = false;
  private enabled = true;

  start(): void {
    this.mount();
    // 实时通道：离屏播放态变化（起播/暂停/切歌）由广播立即推送
    this.onMsg = (msg: unknown) => {
      if ((msg as { type?: string })?.type === 'SETTINGS_CHANGED') void this.poll();
      if (
        msg &&
        typeof msg === 'object' &&
        (msg as { type?: string }).type === 'OFFSCREEN_STATE'
      ) {
        this.playback = (msg as OffscreenStateMessage).state;
        this.render();
      }
    };
    browser.runtime.onMessage.addListener(this.onMsg);
    // 轮询兜底：SW 休眠重启后拉取设置（floating_ball/总开关）与核对播放态
    this.timer = setInterval(() => void this.poll(), BALL_POLL_MS);
    void this.poll();
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    if (this.onMsg) browser.runtime.onMessage.removeListener(this.onMsg);
    this.host?.remove();
    window.removeEventListener('resize', this.onResize);
    this.host = null;
    this.ballEl = null;
    this.labelEl = null;
  }

  private mount(): void {
    const host = document.createElement('div');
    host.id = 'mbook-floating-ball';
    // all:initial 锁定宿主页样式不穿透；fixed 锚定右下角
    host.style.cssText =
      'all: initial; position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = BALL_SHADOW_HTML;
    this.ballEl = root.querySelector('#mbook-ball');
    this.labelEl = root.querySelector('#mbook-label');
    this.nextEl = root.querySelector('#mbook-next');
    this.nextEl?.addEventListener('click', () => { void browser.runtime.sendMessage({ type: 'NEXT_TRACK' }).catch(() => {}); });
    this.ballEl?.addEventListener('click', () => void this.onClick());
    this.ballEl?.addEventListener('pointerdown', (e) => {
      const rect = host.getBoundingClientRect();
      this.dragged = false;
      this.point = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      this.ballEl?.setPointerCapture(e.pointerId);
    });
    this.ballEl?.addEventListener('pointermove', (e) => {
      if (!this.point) return;
      const dx = e.clientX - this.point.x, dy = e.clientY - this.point.y;
      if (Math.hypot(dx, dy) > 5) this.dragged = true;
      if (this.dragged) this.position(this.point.left + dx, this.point.top + dy);
    });
    const endDrag = () => {
      this.point = null;
      if (this.dragged) {
        const rect = host.getBoundingClientRect();
        void browser.storage.local.set({ mbook_ball_position: { x: rect.left, y: rect.top } }).catch(() => {});
      }
    };
    this.ballEl?.addEventListener('pointerup', endDrag);
    this.ballEl?.addEventListener('pointercancel', endDrag);
    (document.body ?? document.documentElement).appendChild(host);
    this.host = host;
    window.addEventListener('resize', this.onResize);
    void browser.storage.local.get('mbook_ball_position').then((value) => {
      const p = value.mbook_ball_position as { x?: number; y?: number } | undefined;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) this.position(p.x!, p.y!);
    }).catch(() => {});
  }

  private position(x: number, y: number): void {
    if (!this.host) return;
    this.host.style.right = 'auto'; this.host.style.bottom = 'auto';
    this.host.style.left = `${Math.max(0, Math.min(window.innerWidth - Math.max(108, this.host.offsetWidth), x))}px`;
    this.host.style.top = `${Math.max(0, Math.min(window.innerHeight - 54, y))}px`;
  }
  private onResize = (): void => {
    const r = this.host?.getBoundingClientRect();
    if (r) this.position(r.left, r.top);
  };

  private async poll(): Promise<void> {
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'GET_BALL_STATE',
      })) as BallStateResponse | undefined;
      if (res) {
        this.visible = res.visible;
        this.enabled = res.enabled;
        this.playback = res.playback;
        this.configure({ ...res.readingSettings, plugin_enabled: res.enabled });
        this.render();
      }
    } catch (e) {
      if (isExtensionContextError(e)) {
        this.stop();
        this.contextInvalidated();
      }
      // SW 休眠/上下文作废：静默，下一次轮询或广播兜底
    }
  }

  private async onClick(): Promise<void> {
    if (this.dragged) { this.dragged = false; return; }
    // 浮球点击 = 用户手势：播放中→暂停（手动暂停最高优先级，不被自动逻辑覆盖）；暂停→恢复
    const type =
      this.playback.status === 'playing'
        ? 'PAUSE'
        : this.playback.status === 'paused'
          ? 'RESUME'
          : 'NEXT_TRACK';
    if (!type) return;
    try {
      await browser.runtime.sendMessage({ type });
    } catch {
      // 通道失效静默
    }
  }

  private render(): void {
    if (!this.ballEl || !this.labelEl) return;
    const p = this.playback;
    const active = p.status === 'playing' || p.status === 'paused';
    const show = this.visible && this.enabled;

    this.ballEl.classList.toggle('hidden', !show);
    this.labelEl.classList.toggle('hidden', !show || !p.title);
    this.nextEl?.classList.toggle('hidden', !show);
    if (!show) return;

    const playing = p.status === 'playing';
    this.ballEl.textContent = playing ? '♪' : active ? '⏸' : '▶';
    this.ballEl.className = `ball ${playing ? 'playing' : 'paused'}`;
    this.ballEl.title = `${p.title ?? 'MBook'}（点击${playing ? '暂停' : '恢复'}）`;
    this.labelEl.textContent = playing
      ? `正在播放 · ${p.title ?? ''}`
      : `⏸ 已暂停 · ${p.title ?? ''}`;
    if (this.host?.style.left) this.onResize();
  }
}
