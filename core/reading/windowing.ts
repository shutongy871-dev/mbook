// 起始段落与实际窗口正文共同标识窗口，避免同章 DOM 更新后误命中旧缓存。

// 轻量 FNV-1a 哈希，输出短十六进制串（仅做标识，不需要加密强度）
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function buildWindowId(
  chapterKey: string,
  firstVisibleIndex: number,
  text = '',
): string {
  return `w_${shortHash(`${chapterKey}#${Math.max(0, firstVisibleIndex)}#${text}`)}`;
}
