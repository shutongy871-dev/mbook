import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWereadCanvasCapture } from '@/core/reading/weread-canvas';
import { acceptWereadCanvas, clearWereadCache, getWereadCanvas } from '@/core/reading/weread-bridge';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearWereadCache(); });
describe('WeRead rendered canvas text', () => {
  it('orders glyphs and clears stale text on erase, resize, navigation and teardown', async () => {
    vi.useFakeTimers();
    class Canvas {
      isConnected = true;
      inReader = true;
      _width = 300; _height = 300;
      get width() { return this._width; } set width(v) { this._width = v; }
      get height() { return this._height; } set height(v) { this._height = v; }
      matches() { return this.inReader; } setAttribute() {}
      checkVisibility() { return true; }
      getBoundingClientRect() { return { width: 300, height: 300 }; }
    }
    class Context {
      constructor(public canvas: Canvas) {}
      fillText(_text: string, _x: number, _y: number) {}
      drawImage(_source: Canvas, _x: number, _y: number) {}
      clearRect(_x: number, _y: number, _w: number, _h: number) {}
      getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
      measureText(text: string) { return { width: text.length * 16, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 16, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 2 }; }
    }
    const postMessage = vi.fn();
    const location = { href: 'https://weread.qq.com/web/reader/one', origin: 'https://weread.qq.com' };
    vi.stubGlobal('HTMLCanvasElement', Canvas); vi.stubGlobal('CanvasRenderingContext2D', Context);
    vi.stubGlobal('window', { postMessage }); vi.stubGlobal('location', location);
    const original = Context.prototype.fillText;
    const stop = installWereadCanvasCapture();
    const canvas = new Canvas(), ctx = new Context(canvas);
    const snapshot = async () => { await vi.advanceTimersByTimeAsync(500); return postMessage.mock.calls.at(-1)![0]; };
    ctx.fillText('乙', 20, 20); ctx.fillText('甲', 0, 20); ctx.fillText('丙', 0, 40);
    const rendered = (await snapshot()).canvases[0];
    expect(rendered.text).toBe('甲乙\n丙');
    expect(rendered.lines.map((l: { text: string }) => l.text)).toEqual(['甲乙', '丙']);
    expect(rendered.lines[0].region).toEqual({ x: 0, y: 4 / 300, width: 36 / 300, height: 18 / 300 });
    expect(acceptWereadCanvas({ type: 'MBOOK_WEREAD_CANVAS', url: location.href, canvases: [rendered] }, location.href)).toBe(true);
    ctx.clearRect(0, 0, 300, 300);
    expect((await snapshot()).canvases).toEqual([]);
    ctx.fillText('旧', 0, 20);
    canvas.width = 300;
    ctx.fillText('新', 0, 20);
    expect((await snapshot()).canvases[0].text).toBe('新');
    location.href = 'https://weread.qq.com/web/reader/two';
    expect((await snapshot()).canvases).toEqual([]);
    ctx.fillText('下一章', 0, 20);
    canvas.isConnected = false;
    expect((await snapshot()).canvases).toEqual([]);
    stop();
    expect(Context.prototype.fillText).toBe(original);
    const calls = postMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(postMessage).toHaveBeenCalledTimes(calls);
  });
  it('captures a detached pre-rendered page and publishes it only after it enters the reader', async () => {
    vi.useFakeTimers();
    class Canvas {
      isConnected = false; inReader = false; width = 300; height = 300;
      matches() { return this.inReader; } setAttribute() {}
      checkVisibility() { return true; }
      getBoundingClientRect() { return { width: 300, height: 300 }; }
    }
    class Context {
      constructor(public canvas: Canvas) {}
      fillText(_text: string, _x: number, _y: number) {}
      drawImage(_source: Canvas, _x: number, _y: number) {}
      clearRect(_x: number, _y: number, _w: number, _h: number) {}
      getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
      measureText(text: string) { return { width: text.length * 16, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 2 }; }
    }
    const postMessage = vi.fn();
    vi.stubGlobal('HTMLCanvasElement', Canvas); vi.stubGlobal('CanvasRenderingContext2D', Context);
    vi.stubGlobal('window', { postMessage });
    vi.stubGlobal('location', { href: 'https://weread.qq.com/web/reader/one', origin: 'https://weread.qq.com' });
    const stop = installWereadCanvasCapture();
    const canvas = new Canvas(), ctx = new Context(canvas);
    ctx.fillText('后续页面正文', 0, 20);
    await vi.advanceTimersByTimeAsync(500);
    expect(postMessage.mock.calls.at(-1)![0].canvases).toEqual([]);
    canvas.isConnected = true; canvas.inReader = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(postMessage.mock.calls.at(-1)![0].canvases[0].text).toBe('后续页面正文');
    stop();
  });
  it('follows text from an offscreen canvas copied into the visible reader canvas', async () => {
    vi.useFakeTimers();
    class Canvas {
      isConnected = false; inReader = false; width = 300; height = 300;
      matches() { return this.inReader; } setAttribute() {}
      checkVisibility() { return true; }
      getBoundingClientRect() { return { width: 300, height: 300 }; }
    }
    class Context {
      constructor(public canvas: Canvas) {}
      fillText(_text: string, _x: number, _y: number) {}
      drawImage(_source: Canvas, _x: number, _y: number) {}
      clearRect(_x: number, _y: number, _w: number, _h: number) {}
      getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
      measureText(text: string) { return { width: text.length * 16, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 2 }; }
    }
    const postMessage = vi.fn();
    vi.stubGlobal('HTMLCanvasElement', Canvas); vi.stubGlobal('CanvasRenderingContext2D', Context);
    vi.stubGlobal('window', { postMessage });
    vi.stubGlobal('location', { href: 'https://weread.qq.com/web/reader/one', origin: 'https://weread.qq.com' });
    const stop = installWereadCanvasCapture();
    const source = new Canvas(), visible = new Canvas();
    visible.isConnected = true; visible.inReader = true;
    new Context(source).fillText('翻页后的正文', 0, 20);
    new Context(visible).drawImage(source, 0, 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(postMessage.mock.calls.at(-1)![0].canvases[0].text).toBe('翻页后的正文');
    stop();
  });
  it('rejects foreign chapter/selector injection and expires missed render snapshots', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const valid = { type: 'MBOOK_WEREAD_CANVAS', url: 'a', canvases: [{ id: 'mbook-canvas-1', text: '正文' }] };
    expect(acceptWereadCanvas(valid, 'b')).toBe(false);
    expect(acceptWereadCanvas({ ...valid, canvases: [{ id: '"]body', text: '正文' }] }, 'a')).toBe(false);
    expect(acceptWereadCanvas({ ...valid, canvases: [{ ...valid.canvases[0], lines: [
      { text: '正文', region: { x: 0, y: -1, width: 1, height: .1 } },
    ] }] }, 'a')).toBe(false);
    expect(acceptWereadCanvas(valid, 'a')).toBe(true);
    expect(getWereadCanvas('a')).toHaveLength(1);
    vi.setSystemTime(12001);
    expect(getWereadCanvas('a')).toEqual([]);
  });
});
