// 站点抽取器接口：负责从不同阅读站点的 DOM 中找到"正文在哪"
// 类比：每个站点像不同版式的书，抽取器就是对应版式的"书签定位器"

// Canvas 文本行在所属元素中的相对位置（0–1），滚动/缩放后仍能定位。
export interface TextRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractedParagraph {
  index: number; // 段落序号（按正文顺序，过滤空段落后重新编号）
  el: Element; // 段落 DOM 元素（供 IntersectionObserver 判断可见性）
  text: string; // trim 后的纯文本
  len: number; // 字数（去除所有空白字符，中文按字计）
  region?: TextRegion; // 普通 DOM 段落不需要；Canvas 按行判断可见性
}

export interface ExtractedContent {
  extractor: string; // 命中的适配器名：weread / generic
  chapter: string | null; // 章节标题，识别不到为 null
  paragraphs: ExtractedParagraph[];
}

export interface SiteExtractor {
  name: string;
  matches(url: URL): boolean;
  extract(doc: Document): ExtractedContent | null;
}

// 字数统计：中文场景按非空白字符数计
export function textLen(text: string): number {
  return text.replace(/\s/g, '').length;
}

// 从容器内按选择器收集段落，过滤空段并顺序编号
export function collectParagraphs(
  container: Element,
  selector: string,
): ExtractedParagraph[] {
  const nodes = Array.from(container.querySelectorAll(selector));
  const paragraphs: ExtractedParagraph[] = [];
  for (const el of nodes) {
    const text = (el.textContent ?? '').trim();
    const len = textLen(text);
    if (len > 0) {
      paragraphs.push({ index: paragraphs.length, el, text, len });
    }
  }
  return paragraphs;
}
