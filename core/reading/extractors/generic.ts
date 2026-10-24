import {
  collectParagraphs,
  textLen,
  type ExtractedContent,
  type ExtractedParagraph,
} from './types';
import { Readability } from '@mozilla/readability';

// 通用抽取器（知乎 / 豆瓣 / 公众号 / 小说站 / 任意文章页）：
// 思路是"找全文文字最密集的容器"——正文区段落多、字数大，
// 导航/评论/推荐区的 <p> 零散短小，密度对比明显。

const MIN_PARAGRAPHS = 3;
const MIN_TOTAL_CHARS = 200;
const MAX_P_NODES = 3000; // 大页面兜底，防止遍历爆炸

function score(paras: ExtractedParagraph[]): number {
  return paras.reduce((sum, p) => sum + p.len, 0);
}

// 候选语义容器：文章/正文地标
const SEMANTIC_SELECTORS = ['article', 'main', '[role="main"]'];

function pickChapter(container: Element | null, doc: Document): string | null {
  if (container) {
    const heading = container.querySelector('h1, h2, h3');
    const t = (heading?.textContent ?? '').trim();
    if (t && textLen(t) >= 2) return t.slice(0, 80);
  }
  const title = (doc.title ?? '').trim();
  return title ? title.slice(0, 80) : null;
}

export const genericExtractor = {
  name: 'generic',

  matches(): boolean {
    return true; // 兜底适配器，始终候选
  },

  extract(doc: Document): ExtractedContent | null {
    // Readability 在副本上清理导航/广告；通过索引映射回真实节点供可见性观察。
    try {
      const original = Array.from(doc.querySelectorAll('p')).slice(0, MAX_P_NODES);
      const clone = doc.cloneNode(true) as Document;
      Array.from(clone.querySelectorAll('p')).slice(0, MAX_P_NODES)
        .forEach((p, i) => p.setAttribute('data-mbook-index', String(i)));
      const article = new Readability(clone, { charThreshold: MIN_TOTAL_CHARS, maxElemsToParse: 20000 }).parse();
      if (article?.content) {
        const container = doc.createElement('div');
        container.innerHTML = article.content;
        const paragraphs = Array.from(container.querySelectorAll('[data-mbook-index]')).flatMap(p => {
          const el = original[Number(p.getAttribute('data-mbook-index'))];
          const text = el?.textContent?.trim() ?? '';
          return el && textLen(text) > 0 ? [{ el, text, len: textLen(text), index: 0 }] : [];
        }).map((p, index) => ({ ...p, index }));
        if (paragraphs.length && score(paragraphs) >= MIN_TOTAL_CHARS)
          return { extractor: 'generic', chapter: article.title ?? pickChapter(null, doc), paragraphs };
      }
    } catch { /* 特殊 DOM 无法解析时使用密度兜底 */ }
    let best: ExtractedParagraph[] = [];

    // 第一轮：语义容器内的 <p>
    for (const sel of SEMANTIC_SELECTORS) {
      for (const container of Array.from(doc.querySelectorAll(sel))) {
        const paras = collectParagraphs(container, 'p');
        if (paras.length >= MIN_PARAGRAPHS && score(paras) > score(best)) {
          best = paras;
        }
      }
    }

    // 第二轮：语义容器没命中 → 按父容器分组全页 <p>，取密度最高的一组
    if (score(best) < MIN_TOTAL_CHARS) {
      const allP = Array.from(doc.body?.querySelectorAll('p') ?? []).slice(
        0,
        MAX_P_NODES,
      );
      const groups = new Map<Element, ExtractedParagraph[]>();
      for (const el of allP) {
        const parent = el.parentElement;
        if (!parent) continue;
        const text = (el.textContent ?? '').trim();
        const len = textLen(text);
        if (len === 0) continue;
        const group = groups.get(parent) ?? [];
        group.push({ index: group.length, el, text, len });
        groups.set(parent, group);
      }
      for (const paras of groups.values()) {
        if (paras.length >= MIN_PARAGRAPHS && score(paras) > score(best)) {
          best = paras;
        }
      }
    }

    if (best.length < MIN_PARAGRAPHS || score(best) < MIN_TOTAL_CHARS) {
      return null; // 列表页 / 工具页，没有可读正文
    }

    // 重新编号（分组兜底场景下各组的 index 是组内编号）
    const paragraphs = best.map((p, i) => ({ ...p, index: i }));
    return {
      extractor: 'generic',
      chapter: pickChapter(paragraphs[0]?.el.parentElement ?? null, doc),
      paragraphs,
    };
  },
};
