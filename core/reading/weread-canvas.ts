import { WEREAD_CANVAS_SELECTOR, type WereadCanvasText } from './weread-bridge';

// Observe the site's ordinary text rendering only. No OCR, network replay or decryption.
// Each snapshot is tied to an actual canvas and current URL; all state stays in memory.
export function installWereadCanvasCapture(): () => void {
  const proto = CanvasRenderingContext2D.prototype;
  const fillText = proto.fillText;
  const drawImage = proto.drawImage;
  const clearRect = proto.clearRect;
  const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  const height = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
  type Glyph = { x: number; y: number; left: number; top: number; right: number; bottom: number; text: string };
  type Frame = { url: string; id: string; glyphs: Map<string, Glyph>; lastDrawAt: number };
  const frames = new Map<HTMLCanvasElement, Frame>();
  let serial = 0;
  const target = (canvas: HTMLCanvasElement) => canvas.matches(WEREAD_CANVAS_SELECTOR);
  const frameFor = (canvas: HTMLCanvasElement): Frame => {
    let frame = frames.get(canvas);
    if (!frame || frame.url !== location.href) {
      frame = { url: location.href, id: `mbook-canvas-${++serial}`, glyphs: new Map(), lastDrawAt: Date.now() };
      frames.set(canvas, frame);
      if (frames.size > 16) frames.delete(frames.keys().next().value!);
      canvas.setAttribute('data-mbook-canvas', frame.id);
    }
    return frame;
  };
  const textHook: typeof fillText = function (this: CanvasRenderingContext2D, ...args) {
    const result = fillText.apply(this, args);
    // Instrumentation cannot break the site's rendering, even if the DOM changes mid-frame.
    try {
      const canvas = this.canvas;
      // WeRead renders later pages on detached canvases, then mounts them into
      // the reader. Capture the bounded draw now; publish() still requires the
      // canvas to be connected, visible and inside the reader.
      if (typeof args[0] !== 'string' || args[0].length > 1000) return result;
      const frame = frameFor(canvas);
      const m = this.getTransform();
      frame.lastDrawAt = Date.now();
      const x = Math.round(m.a * args[1] + m.c * args[2] + m.e);
      const y = Math.round(m.b * args[1] + m.d * args[2] + m.f);
      if (x >= 0 && x < canvas.width && y >= 0 && y <= canvas.height && frame.glyphs.size < 10000) {
        const metrics = this.measureText(args[0]);
        const ascent = metrics.actualBoundingBoxAscent || metrics.fontBoundingBoxAscent || 16;
        const descent = metrics.actualBoundingBoxDescent || metrics.fontBoundingBoxDescent || 2;
        const left = args[1] - (metrics.actualBoundingBoxLeft || 0);
        const right = args[1] + (metrics.actualBoundingBoxRight || metrics.width);
        const points = [
          [left, args[2] - ascent], [right, args[2] - ascent],
          [left, args[2] + descent], [right, args[2] + descent],
        ].map(([px = 0, py = 0]) => ({ x: m.a * px + m.c * py + m.e, y: m.b * px + m.d * py + m.f }));
        frame.glyphs.set(`${x}:${y}`, {
          x, y, text: args[0],
          left: Math.max(0, Math.min(...points.map(p => p.x))),
          right: Math.min(canvas.width, Math.max(...points.map(p => p.x))),
          top: Math.max(0, Math.min(...points.map(p => p.y))),
          bottom: Math.min(canvas.height, Math.max(...points.map(p => p.y))),
        });
      }
    } catch { /* observation is optional */ }
    return result;
  };
  const drawImageHook = function (this: CanvasRenderingContext2D, ...rawArgs: unknown[]) {
    const args = rawArgs as [CanvasImageSource, ...number[]];
    const result = Reflect.apply(drawImage, this, args);
    try {
      const source = args[0];
      if (!(source instanceof HTMLCanvasElement) || source === this.canvas) return result;
      const sourceFrame = frames.get(source);
      if (!sourceFrame || sourceFrame.url !== location.href || !source.width || !source.height) return result;
      let sx = 0, sy = 0, sw = source.width, sh = source.height;
      let dx = Number(args[1]), dy = Number(args[2]), dw = sw, dh = sh;
      if (args.length === 5) {
        dw = Number(args[3]); dh = Number(args[4]);
      } else if (args.length === 9) {
        sx = Number(args[1]); sy = Number(args[2]); sw = Number(args[3]); sh = Number(args[4]);
        dx = Number(args[5]); dy = Number(args[6]); dw = Number(args[7]); dh = Number(args[8]);
      }
      if (![sx, sy, sw, sh, dx, dy, dw, dh].every(Number.isFinite) || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return result;
      const canvas = this.canvas;
      const frame = frameFor(canvas);
      if (dx <= 0 && dy <= 0 && dw >= canvas.width && dh >= canvas.height) frame.glyphs.clear();
      const m = this.getTransform();
      const point = (x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
      for (const glyph of sourceFrame.glyphs.values()) {
        if (frame.glyphs.size >= 10000) break;
        const centerX = (glyph.left + glyph.right) / 2, centerY = (glyph.top + glyph.bottom) / 2;
        if (centerX < sx || centerX > sx + sw || centerY < sy || centerY > sy + sh) continue;
        const mapX = (x: number) => dx + (x - sx) * dw / sw;
        const mapY = (y: number) => dy + (y - sy) * dh / sh;
        const baseline = point(mapX(glyph.x), mapY(glyph.y));
        const corners = [
          point(mapX(glyph.left), mapY(glyph.top)), point(mapX(glyph.right), mapY(glyph.top)),
          point(mapX(glyph.left), mapY(glyph.bottom)), point(mapX(glyph.right), mapY(glyph.bottom)),
        ];
        const x = Math.round(baseline.x), y = Math.round(baseline.y);
        frame.glyphs.set(`${x}:${y}`, {
          x, y, text: glyph.text,
          left: Math.max(0, Math.min(...corners.map(p => p.x))),
          right: Math.min(canvas.width, Math.max(...corners.map(p => p.x))),
          top: Math.max(0, Math.min(...corners.map(p => p.y))),
          bottom: Math.min(canvas.height, Math.max(...corners.map(p => p.y))),
        });
      }
      frame.lastDrawAt = Date.now();
    } catch { /* observation is optional */ }
    return result;
  } as typeof drawImage;
  const clearHook: typeof clearRect = function (this: CanvasRenderingContext2D, ...args) {
    const result = clearRect.apply(this, args);
    // Partial clearing also discards the frame conservatively; never retain erased words.
    frames.delete(this.canvas);
    return result;
  };
  const widthHook = function (this: HTMLCanvasElement, value: number) {
    frames.delete(this);
    width?.set?.call(this, value);
  };
  const heightHook = function (this: HTMLCanvasElement, value: number) {
    frames.delete(this);
    height?.set?.call(this, value);
  };
  proto.fillText = textHook;
  proto.drawImage = drawImageHook;
  proto.clearRect = clearHook;
  if (width?.configurable && width.set) Object.defineProperty(HTMLCanvasElement.prototype, 'width', { ...width, set: widthHook });
  if (height?.configurable && height.set) Object.defineProperty(HTMLCanvasElement.prototype, 'height', { ...height, set: heightHook });
  const publish = () => {
    const canvases: WereadCanvasText[] = [];
    for (const [canvas, frame] of frames) {
      if (frame.url !== location.href || Date.now() - frame.lastDrawAt > 30_000) {
        frames.delete(canvas);
        continue;
      }
      // A later page can remain detached while WeRead pre-renders it.
      if (!canvas.isConnected || !target(canvas)) continue;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height || !canvas.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const glyphs = [...frame.glyphs.values()].sort((a, b) => a.y - b.y || a.x - b.x);
      const rows: Glyph[] = [];
      let lastY = -Infinity;
      for (const glyph of glyphs) {
        if (glyph.right <= glyph.left || glyph.bottom <= glyph.top) continue;
        if (Math.abs(glyph.y - lastY) > 2) {
          rows.push({ ...glyph }); lastY = glyph.y;
        } else {
          const row = rows[rows.length - 1]!;
          row.text += glyph.text;
          row.left = Math.min(row.left, glyph.left); row.right = Math.max(row.right, glyph.right);
          row.top = Math.min(row.top, glyph.top); row.bottom = Math.max(row.bottom, glyph.bottom);
        }
      }
      let remaining = 10000;
      const lines: NonNullable<WereadCanvasText['lines']> = [];
      for (const row of rows.slice(0, 1000)) {
        const text = row.text.trim().slice(0, remaining);
        if (!text) continue;
        lines.push({ text, region: {
          x: row.left / canvas.width, y: row.top / canvas.height,
          width: (row.right - row.left) / canvas.width, height: (row.bottom - row.top) / canvas.height,
        } });
        remaining -= text.length + 1;
        if (remaining <= 0) break;
      }
      const text = lines.map(l => l.text).join('\n');
      if (text && canvases.length < 16) canvases.push({ id: frame.id, text, lines });
    }
    window.postMessage({ type: 'MBOOK_WEREAD_CANVAS', url: location.href, canvases }, location.origin);
  };
  const timer = setInterval(publish, 500);
  return () => {
    clearInterval(timer);
    frames.clear();
    if (proto.fillText === textHook) proto.fillText = fillText;
    if (proto.drawImage === drawImageHook) proto.drawImage = drawImage;
    if (proto.clearRect === clearHook) proto.clearRect = clearRect;
    if (Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')?.set === widthHook && width) Object.defineProperty(HTMLCanvasElement.prototype, 'width', width);
    if (Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height')?.set === heightHook && height) Object.defineProperty(HTMLCanvasElement.prototype, 'height', height);
    window.postMessage({ type: 'MBOOK_WEREAD_CANVAS', url: location.href, canvases: [] }, location.origin);
  };
}
