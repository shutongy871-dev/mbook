import { collectParagraphs, textLen, type ExtractedContent, type ExtractedParagraph } from './types';
import { getWereadCanvas, getWereadParagraphs, WEREAD_CANVAS_SELECTOR } from '../weread-bridge';

// 微信读书网页版适配器（weread.qq.com）
// 接口/绘制正文必须映射到可见 DOM 元素；不处理密文或未绘制章节。
// 选择器按候选列表逐个尝试，站点改版时只要有一个命中即可工作；
// 全部未命中则返回 null，由注册表回退到通用抽取器。

// .app_content 包含书架、目录和弹窗，不能作为正文兜底。
const CONTENT_SELECTORS = ['.readerChapterContent', '.reader_content'];
const NON_CONTENT = '#preRenderContainer, .preRenderContainer, .wr_dialog, [role="dialog"], .readerControls, .horizontalReaderCoverPage, [class*="reader_float_"]';
const CHAPTER_SELECTORS = ['.renderTargetPageInfo_header_chapterTitle', '.chapterTitle', '.readerCatalog_currentChapter', '.readerTopBar_title'];

function pickText(doc: Document, selectors: string[]): string | null {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const t = (el?.textContent ?? '').trim();
    if (t.length >= 2) return t.slice(0, 80);
  }
  return null;
}

export const wereadExtractor = {
  name: 'weread',

  matches(url: URL): boolean {
    return url.hostname === 'weread.qq.com';
  },

  extract(doc: Document): ExtractedContent | null {
    const canvases = Array.from(doc.querySelectorAll(WEREAD_CANVAS_SELECTOR));
    const canvasParagraphs = getWereadCanvas(doc.location?.href ?? '').flatMap(({ id, text, lines }): ExtractedParagraph[] => {
      const el = canvases.find(c => c.getAttribute('data-mbook-canvas') === id);
      if (!el || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return [];
      return lines?.length
        ? lines.map(line => ({ el, text: line.text, len: textLen(line.text), region: line.region, index: 0 }))
        : [{ el, text, len: textLen(text), index: 0 }];
    }).map((p, index) => ({ ...p, index }));
    if (canvasParagraphs.length) return {
      extractor: 'weread-canvas', chapter: pickText(doc, CHAPTER_SELECTORS) ?? doc.title, paragraphs: canvasParagraphs,
    };
    // 画布尚未绘制/缓存过期时等待下一次快照，不用控制区文字冒充正文。
    if (canvases.length) return null;
    let paragraphs: ReturnType<typeof collectParagraphs> = [];
    for (const sel of CONTENT_SELECTORS) {
      const container = doc.querySelector(sel);
      if (!container) continue;
      const visible = (p: { el: Element }) => p.el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        !p.el.closest(NON_CONTENT);
      const paras = collectParagraphs(container, 'p').filter(visible);
      if (paras.reduce((n, p) => n + p.len, 0) >= 80) {
        paragraphs = paras;
        break;
      }
      // 部分章节用 <div> 排版：取容器内直接子文本块兜底
      const divParas = collectParagraphs(container, 'div').filter((p) => !p.el.querySelector('p, div') && visible(p));
      if (divParas.reduce((n, p) => n + p.len, 0) >= 80 && divParas.length > paragraphs.length) {
        paragraphs = divParas;
      }
    }

    if (!paragraphs.length) return null;

    const apiTexts = getWereadParagraphs(doc.location?.href ?? '');
    const normalized = (s: string) => s.replace(/\s/g, '');
    let mapped = 0;
    paragraphs = paragraphs.map((p, index) => {
      const text = apiTexts.find((s) => normalized(s) === normalized(p.text));
      if (text) mapped++;
      return { ...p, index, text: text ?? p.text };
    });
    return {
      extractor: mapped ? 'weread-api' : 'weread',
      chapter: pickText(doc, CHAPTER_SELECTORS) ?? doc.title,
      paragraphs,
    };
  },
};
