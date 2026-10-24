import { z } from 'zod';

// 工程决策：方案未列全 18 项，以已有九项为基础补齐互补氛围。
export const ATMOSPHERE_TAGS = [
  '平静舒缓', '温暖治愈', '悲伤低落', '紧张悬疑', '希望上扬', '高潮燃向',
  '专注沉浸', '夜晚松弛', '神秘未知', '浪漫柔情', '孤独疏离', '庄严宏大',
  '轻快愉悦', '怀旧回忆', '黑暗压抑', '梦幻空灵', '自然清新', '冲突激烈',
] as const;
export const TagSchema = z.enum(ATMOSPHERE_TAGS);
export const EmotionSchema = z.array(z.number().min(0).max(1)).length(8);

const ALIASES: Record<string, typeof ATMOSPHERE_TAGS[number]> = {
  安静: '平静舒缓', 平静: '平静舒缓', 钢琴: '平静舒缓', 治愈: '温暖治愈',
  温暖: '温暖治愈', 忧伤: '悲伤低落', 悲伤: '悲伤低落', 悬疑: '紧张悬疑',
  紧张: '紧张悬疑', 励志: '希望上扬', 燃: '高潮燃向', 史诗: '庄严宏大',
  学习: '专注沉浸', 专注: '专注沉浸', 放松: '夜晚松弛', 神秘: '神秘未知',
  浪漫: '浪漫柔情', 孤独: '孤独疏离', 快乐: '轻快愉悦', 怀旧: '怀旧回忆',
  黑暗: '黑暗压抑', 空灵: '梦幻空灵', 自然: '自然清新', 战斗: '冲突激烈',
};
export function mapTags(tags: string[]): string[] {
  return [...new Set(tags.flatMap(t => TagSchema.safeParse(t).success ? [t] :
    Object.entries(ALIASES).filter(([word]) => t.includes(word)).map(([, tag]) => tag)))];
}

export function voteTags(sources: Array<{ weight: number; tags: Array<{ tag: string; confidence: number }> }>) {
  const available = sources.filter(s => s.tags.length);
  const denominator = available.reduce((n, s) => n + s.weight, 0);
  const votes = new Map<string, number>();
  for (const source of available) for (const tag of source.tags) {
    if (TagSchema.safeParse(tag.tag).success)
      votes.set(tag.tag, (votes.get(tag.tag) ?? 0) + source.weight * tag.confidence);
  }
  return [...votes].map(([tag, n]) => ({ tag, confidence: n / denominator }))
    .filter(t => t.confidence >= .4).sort((a, b) => b.confidence - a.confidence);
}
