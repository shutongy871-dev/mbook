import { genericExtractor } from './generic';
import { wereadExtractor } from './weread';
import type { ExtractedContent, SiteExtractor } from './types';

// 站点适配器注册表：专属站点优先，通用密度抽取兜底
const SITE_EXTRACTORS: SiteExtractor[] = [wereadExtractor];

export function extractReadingContent(
  url: URL,
  doc: Document,
): ExtractedContent | null {
  for (const extractor of SITE_EXTRACTORS) {
    if (!extractor.matches(url)) continue;
    try {
      const content = extractor.extract(doc);
      // 站点适配器自行校验正文；短章节和单页画布也可能只有一个文本块。
      if (content?.paragraphs.length) return content;
    } catch {
      // 站点 DOM 异常时静默回退
    }
  }
  // Canvas reader contains hidden introductions, catalogs and dialogs; generic extraction
  // must not turn those into a chapter when no current rendered text is available.
  if (url.hostname === 'weread.qq.com' && url.pathname.startsWith('/web/reader/')) return null;
  return genericExtractor.extract(doc);
}

export type { ExtractedContent, ExtractedParagraph, SiteExtractor } from './types';
