import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
const send = vi.hoisted(() => vi.fn(async (_message: unknown) => undefined));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: send } } }));
import { ReadingCollector } from '@/core/reading/collector';
import { buildWindowId } from '@/core/reading/windowing';
import { judgeReadingState } from '@/core/reading/reading-state';
import { acceptWereadCanvas, acceptWereadPayload, clearWereadCache, extractApiParagraphs, getWereadParagraphs } from '@/core/reading/weread-bridge';
import { extractReadingContent } from '@/core/reading/extractors';
import { normalizeSettings, DEFAULT_SETTINGS } from '@/core/db/settings.repo';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearWereadCache(); });

function wereadDocument(body: string) {
  const { document, window } = parseHTML(`<html><body>${body}</body></html>`);
  const location = { href: 'https://weread.qq.com/web/reader/chapter-one', hostname: 'weread.qq.com' };
  Object.defineProperty(document, 'location', { value: location, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  Object.assign(window, { scrollY: 0, innerWidth: 1000, innerHeight: 800 });
  window.Element.prototype.checkVisibility = function () { return !this.closest('[hidden]'); };
  vi.stubGlobal('document', document); vi.stubGlobal('window', window);
  vi.stubGlobal('location', location); vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private cb: (entries: unknown[]) => void) {}
    observe(el: Element) {
      // The chapter canvas is taller than the viewport; ordinary paragraphs are visible.
      this.cb([{ target: el, isIntersecting: true, intersectionRatio: el.tagName === 'CANVAS' ? 1 / 3 : 1 }]);
    }
    disconnect() {}
  });
  return { document, window, location };
}

describe('reading collection', () => {
  it('accepts a short WeRead chapter loaded asynchronously and excludes prerender/control text', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const { document, location } = wereadDocument('<div class="readerChapterContent"></div>');
    const collector = new ReadingCollector();
    collector.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ state: { paragraph_count: 0 } });
    const text = '这一章只有一个自然段，也应该识别为正在阅读的正文。'.repeat(5);
    document.querySelector('.readerChapterContent')!.innerHTML = `
      <div id="preRenderContainer"><p>${'未展示的下一页'.repeat(40)}</p></div>
      <div class="renderTargetContainer"><p>${text}</p></div>
      <div class="readerControls"><div>${'阅读设置'.repeat(40)}</div></div>`;
    await vi.advanceTimersByTimeAsync(6000);
    expect(extractReadingContent(new URL(location.href), document)?.paragraphs.map(p => p.text)).toEqual([text]);
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      state: { extractor: 'weread', paragraph_count: 1, visible_text_len: text.length, state: 'focused' },
    });
    collector.stop();
  });

  it('collects only visible text rows from a tall WeRead canvas and advances the window on scroll', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const { document, location, window } = wereadDocument(`
      <div class="readerChapterContent"><div class="renderTargetContainer">
        <div class="wr_canvasContainer"><canvas data-mbook-canvas="mbook-canvas-1"></canvas></div>
      </div></div>`);
    const canvas = document.querySelector('canvas')!;
    let top = 0;
    canvas.getBoundingClientRect = () => ({
      x: 100, y: top, left: 100, right: 700, top, bottom: top + 2400, width: 600, height: 2400,
      toJSON() { return {}; },
    });
    const first = '窗外很平静，他坐在桌边慢慢阅读。'.repeat(8);
    const second = '远处传来脚步声，他紧张地看向门外。'.repeat(8);
    const payload = {
      type: 'MBOOK_WEREAD_CANVAS', url: location.href,
      canvases: [{ id: 'mbook-canvas-1', text: `${first}\n${second}`, lines: [
        { text: first, region: { x: 0, y: .1, width: 1, height: .02 } },
        { text: second, region: { x: 0, y: .7, width: 1, height: .02 } },
      ] }],
    };
    acceptWereadCanvas(payload, location.href);
    const collector = new ReadingCollector();
    collector.configure({ update_interval_sec: 3 });
    collector.start();
    // The renderer publishes a live snapshot twice a second.
    const publisher = setInterval(() => {
      acceptWereadCanvas(payload, location.href); collector.invalidateContent();
    }, 500);
    await vi.advanceTimersByTimeAsync(4000);
    const before = (send.mock.calls.at(-1)?.[0] as any).state;
    expect(before).toMatchObject({ extractor: 'weread-canvas', paragraph_count: 2, visible_text_len: first.length, state: 'focused' });
    expect(before.visible_text).toBe(first);
    top = -1440; window.scrollY = 1440;
    await vi.advanceTimersByTimeAsync(2000);
    const after = (send.mock.calls.at(-1)?.[0] as any).state;
    expect(after.visible_text_len).toBe(second.length);
    expect(after.first_visible_index).toBe(1);
    expect(after.window_id).not.toBe(before.window_id);
    clearInterval(publisher); collector.stop();
  });

  it('does not mistake reader controls for正文 while a canvas is awaiting its first draw', () => {
    const { document, location } = wereadDocument(`
      <div class="readerChapterContent">
        <div class="wr_canvasContainer"><canvas></canvas></div>
        <div class="readerControls"><div>阅读设置</div><div>加入书架</div><div>微信读书</div></div>
      </div>`);
    expect(extractReadingContent(new URL(location.href), document)).toBeNull();
  });

  it('distinguishes unknown speed from measured slow reading', () => {
    const signals = { page_active: true, stay_sec: 4, scroll_speed_sps: 0, visible_text_len: 300, reading_speed_cpm: 0 };
    expect(judgeReadingState({ ...signals, reading_speed_known: false }).state).toBe('focused');
    expect(judgeReadingState({ ...signals, reading_speed_known: true }).state).toBe('scanning');
    expect(judgeReadingState({ ...signals, page_active: false, reading_speed_known: false }).state).toBe('inactive');
    expect(buildWindowId('a', 1)).not.toBe(buildWindowId('a', 2));
    expect(buildWindowId('a', 1, '旧正文')).not.toBe(buildWindowId('a', 1, '新正文'));
  });
  it('enforces 50% visibility, real elapsed stay, configured text size/interval and cleanup', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const { document, window } = parseHTML(`<html><body><article>${[1, 2, 3].map(() => `<p>${'平静地阅读文字。'.repeat(30)}</p>`).join('')}</article></body></html>`);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.assign(window, { scrollY: 0, innerHeight: 800 });
    vi.stubGlobal('document', document); vi.stubGlobal('window', window);
    vi.stubGlobal('location', { href: 'https://test.invalid/article', hostname: 'test.invalid' });
    vi.stubGlobal('Element', window.Element); vi.stubGlobal('MutationObserver', window.MutationObserver);
    let intersect: (entries: unknown[]) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: typeof intersect) { intersect = cb; }
      observe() {} disconnect = disconnect;
    });
    const collector = new ReadingCollector();
    collector.configure({ window_size: 150, update_interval_sec: 3 });
    collector.start();
    const p = document.querySelector('p')!;
    intersect([{ target: p, isIntersecting: true, intersectionRatio: .49 }]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ state: { visible_text_len: 0, state: 'scanning' } });
    intersect([{ target: p, isIntersecting: true, intersectionRatio: .5 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ state: { state: 'focused', reading_speed_known: false, stay_sec: 5 } });
    expect((send.mock.calls.at(-1)?.[0] as any).state.visible_text).toHaveLength(150);
    const count = send.mock.calls.filter(([m]: any[]) => m.state.visible_text).length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(send.mock.calls.filter(([m]: any[]) => m.state.visible_text)).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send.mock.calls.filter(([m]: any[]) => m.state.visible_text)).toHaveLength(count + 1);
    const container = document.querySelector('article')!;
    Object.assign(container, { scrollTop: 1600, scrollLeft: 0 });
    // linkedom does not implement layout/scroll offsets; set the initial position explicitly.
    (collector as any).scrollPositions.set(container, { x: 0, y: 0 });
    container.dispatchEvent(new window.Event('scroll', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ state: { state: 'scanning', scroll_speed_sps: .8 } });
    collector.stop();
    const calls = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(send.mock.calls).toHaveLength(calls);
    expect(disconnect).toHaveBeenCalled();
  });
  it('isolates chapter payloads and rejects oversize/unrelated data', () => {
    expect(extractApiParagraphs({ data: { content: '本章正文', title: '不采集标题' } })).toEqual(['本章正文']);
    expect(acceptWereadPayload({ type: 'MBOOK_WEREAD_TEXT', url: 'a', paragraphs: ['正文'] }, 'b')).toBe(false);
    expect(acceptWereadPayload({ type: 'MBOOK_WEREAD_TEXT', url: 'a', paragraphs: ['正文'] }, 'a')).toBe(true);
    expect(getWereadParagraphs('a')).toEqual(['正文']);
    expect(getWereadParagraphs('b')).toEqual([]);
  });
  it('clamps invalid settings and normalizes reversed BPM bounds', () => {
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, window_size: 9999, update_interval_sec: 0,
      fade_in_ms: NaN, bpm_ranges: { calm: [100, 60], peak: [80, 120] } });
    expect(settings).toMatchObject({ window_size: 600, update_interval_sec: 3, fade_in_ms: 1500, bpm_ranges: { calm: [60, 100] } });
  });
});
