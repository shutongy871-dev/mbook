import type { TextRegion } from './extractors/types';

// 页面数据是不可信输入；只接受当前 URL 的有限纯文本，不持久化、不执行。
export const WEREAD_CANVAS_SELECTOR = '.readerChapterContent .wr_canvasContainer canvas, .reader_content .wr_canvasContainer canvas';
export interface WereadCanvasText {
  id: string;
  text: string;
  lines?: Array<{ text: string; region: TextRegion }>;
}
let cached: { url: string; paragraphs: string[] } | null = null;
let canvasCache: { url: string; at: number; canvases: WereadCanvasText[] } | null = null;

function validRegion(value: unknown): value is TextRegion {
  if (!value || typeof value !== 'object') return false;
  const r = value as TextRegion;
  return [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
    r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 &&
    r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001;
}

export function acceptWereadCanvas(value: unknown, url: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (data.type !== 'MBOOK_WEREAD_CANVAS' || data.url !== url || !Array.isArray(data.canvases) || data.canvases.length > 16) return false;
  if (!data.canvases.every(c => c && /^mbook-canvas-\d+$/.test(c.id) && typeof c.text === 'string' && c.text.length <= 10000)) return false;
  for (const c of data.canvases) {
    if (c.lines === undefined) continue;
    if (!Array.isArray(c.lines) || c.lines.length > 1000 ||
      !c.lines.every((l: { text?: unknown; region?: unknown } | null) =>
        l && typeof l.text === 'string' && l.text.length <= 10000 && validRegion(l.region)) ||
      c.lines.reduce((n: number, l: { text: string }) => n + l.text.length, 0) > 10000) return false;
  }
  canvasCache = { url, at: Date.now(), canvases: data.canvases.map(c => ({
    id: c.id, text: c.text,
    ...(c.lines ? { lines: c.lines.map((l: { text: string; region: TextRegion }) => ({
      text: l.text, region: { x: l.region.x, y: l.region.y, width: l.region.width, height: l.region.height },
    })) } : {}),
  })) };
  return true;
}

export function getWereadCanvas(url: string): WereadCanvasText[] {
  if (canvasCache?.url !== url || Date.now() - canvasCache.at > 2000) { canvasCache = null; return []; }
  return canvasCache.canvases;
}
export function acceptWereadPayload(value: unknown, url: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (data.type !== 'MBOOK_WEREAD_TEXT' || data.url !== url || !Array.isArray(data.paragraphs)) return false;
  const paragraphs = data.paragraphs.slice(0, 3000).filter((p): p is string => typeof p === 'string' && p.length <= 10000);
  if (!paragraphs.length || paragraphs.join('').length > 250000) return false;
  cached = { url, paragraphs };
  return true;
}
export function getWereadParagraphs(url: string): string[] {
  if (cached?.url !== url) { cached = null; return []; }
  return cached.paragraphs;
}
export function clearWereadCache(): void { cached = null; canvasCache = null; }

// 仅解析明确的正文键；密文/二进制接口不猜测解密。
export function extractApiParagraphs(value: unknown): string[] {
  const result: string[] = [];
  function walk(v: unknown, depth: number): void {
    if (depth > 6 || result.length >= 3000 || !v || typeof v !== 'object') return;
    for (const [key, child] of Object.entries(v)) {
      if (/^(content|text|paragraphs|chapterContent)$/i.test(key)) {
        const strings = typeof child === 'string' ? [child] : Array.isArray(child) ? child.filter((x): x is string => typeof x === 'string') : [];
        for (const text of strings) {
          // 带 HTML 的响应由 isolated world DOMParser 转成文本。
          if (text.length <= 250000 && /[\u3400-\u9fff]/.test(text)) result.push(text);
        }
      }
      if (typeof child === 'object') walk(child, depth + 1);
    }
  }
  walk(value, 0);
  return result;
}
