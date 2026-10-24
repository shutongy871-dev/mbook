// 八维直接打标词典。人工先验，非训练模型；版本变更后画像应重新计算。
// 词条强度描述局部表达，不能当作整段情绪的真值。
import { EMOTION_VOCABULARY } from './emotion-vocabulary';

export const EMOTION_PROFILE_VERSION = 'emotion-8-mean-zero-v5';
export const EMOTION_DIMENSIONS = [
  'joy', 'sadness', 'tenderness', 'hope', 'fear', 'anger', 'mystery', 'solemnity',
] as const;
export type EmotionDimension = typeof EMOTION_DIMENSIONS[number];
export const EMOTION_LABELS: Record<EmotionDimension, string> = {
  joy: '喜悦', sadness: '悲伤', tenderness: '温柔', hope: '希望',
  fear: '恐惧', anger: '愤怒', mystery: '神秘', solemnity: '庄严',
};
export type EmotionStrength = 0 | .25 | .5 | .75 | 1;
export interface EmotionDictionaryEntry {
  term: string;
  scores: Record<EmotionDimension, EmotionStrength>;
}

// 不从旧的 V/A/T 反推类别，不把“未来”“父亲”等普通实体自动视为情绪。
// 每组是同类别、同强度的明确先验；强度仍需通过真实段落校准。
const groups: Array<[EmotionDimension, EmotionStrength, string]> = [
  ['joy', .25, '欣慰 有些欣慰 小小的喜悦'],
  ['joy', .5, '开心 高兴 快乐 喜悦 欢喜 愉快 愉悦 欢乐 欢笑 欢快 欢愉 欣喜 满足 喜爱 喜讯'],
  ['joy', .75, '兴高采烈 喜笑颜开 心花怒放 喜气洋洋 喜上眉梢 欢天喜地 欢欣鼓舞'],
  ['joy', 1, '欣喜若狂 喜不自胜 狂喜'],
  ['sadness', .25, '遗憾 惆怅 叹息 有些失落 淡淡的忧伤'],
  ['sadness', .5, '悲伤 难过 伤心 哀伤 忧伤 忧愁 失落 沮丧 孤独 寂寞 落寞 心酸 哭泣 眼泪 泪水 哀愁 失望 失恋'],
  ['sadness', .75, '悲痛 悲恸 心碎 凄凉 哀痛 心灰意冷 黯然神伤 泪流满面 泣不成声 痛苦'],
  ['sadness', 1, '悲痛欲绝 痛不欲生 肝肠寸断 万念俱灰 绝望'],
  ['tenderness', .25, '轻声安慰 轻轻安慰 轻声细语 轻抚'],
  ['tenderness', .5, '温柔 温情 温暖 温馨 温存 柔情 关怀 呵护 安慰 体贴 亲切 慈爱 怜爱 疼爱 依偎 拥抱 相拥'],
  ['tenderness', .75, '温柔呵护 深情相拥 悉心照料 无微不至 深情'],
  ['tenderness', 1, '满怀深情地呵护 倾尽所有的关爱'],
  ['hope', .25, '一丝期待 一丝希望 微弱的希望 隐约期待'],
  ['hope', .5, '希望 期待 期盼 憧憬 向往 信念 振作 振奋 奋进 奋发 勇气 斗志'],
  ['hope', .75, '充满希望 满怀希望 充满信心 斗志昂扬 百折不挠 勇往直前'],
  ['hope', 1, '坚信一定会成功 对未来充满坚定的信念'],
  ['fear', .25, '胆怯 有些担心 隐隐不安'],
  ['fear', .5, '害怕 恐惧 惶恐 恐慌 惊惧 惊吓 惊悚 忐忑 担忧 担心 不安 焦虑 胆寒'],
  ['fear', .75, '惊恐 惊慌 惊骇 胆战心惊 毛骨悚然 提心吊胆 心惊胆战 惴惴不安 惊魂未定 战战兢兢'],
  ['fear', 1, '魂飞魄散 恐惧万分 吓得魂不附体'],
  ['anger', .25, '不满 有些恼火'],
  ['anger', .5, '愤怒 生气 恼怒 恼火 愤慨 愤恨 怨恨 怒意 怒气 敌意 仇恨 怒斥'],
  ['anger', .75, '暴怒 怒吼 咆哮 义愤填膺 愤愤不平 恼羞成怒 怒目而视'],
  ['anger', 1, '怒不可遏 怒火中烧 怒发冲冠 暴跳如雷 怒气冲天'],
  ['mystery', .25, '有些疑惑 疑惑 疑问 疑点 蹊跷'],
  ['mystery', .5, '神秘 谜团 诡秘 诡异 悬疑 迷局 诡谲 隐秘 离奇 迷雾 未知'],
  ['mystery', .75, '扑朔迷离 古怪莫测 深不可测 真相未明'],
  ['mystery', 1, '完全无法解释的诡异现象 无法窥破的重重谜团'],
  ['solemnity', .25, '郑重 恭敬'],
  ['solemnity', .5, '庄严 肃穆 庄重 敬畏 虔诚 崇敬 敬重'],
  ['solemnity', .75, '庄严肃穆 深深敬畏 肃然起敬 神圣不可侵犯'],
  ['solemnity', 1, '令人震撼的庄严与敬畏'],
];

const entries = new Map<string, EmotionDictionaryEntry>();
const emptyScores = (): Record<EmotionDimension, EmotionStrength> => ({
  joy: 0, sadness: 0, tenderness: 0, hope: 0,
  fear: 0, anger: 0, mystery: 0, solemnity: 0,
});
for (const [dimension, words] of EMOTION_VOCABULARY) {
  for (const term of words.trim().split(/\s+/)) {
    const entry = entries.get(term) ?? { term, scores: emptyScores() };
    entry.scores[dimension] = .5;
    entries.set(term, entry);
  }
}
// 精细强度覆盖扩展词表的0.5初值，保留一个词对应多维的情况。
for (const [dimension, strength, words] of groups) {
  for (const term of words.split(/\s+/)) {
    const entry = entries.get(term) ?? { term, scores: emptyScores() };
    entry.scores[dimension] = strength;
    entries.set(term, entry);
  }
}
// 一个表达可独立贡献多个情绪，不做平均或相互抵消。
entries.set('悲喜交加', { term: '悲喜交加', scores: { ...emptyScores(), joy: .5, sadness: .5 } });
entries.set('温暖的希望', { term: '温暖的希望', scores: { ...emptyScores(), tenderness: .5, hope: .5 } });
export const EMOTION_DICTIONARY: readonly EmotionDictionaryEntry[] = Object.freeze(
  [...entries.values()].map(entry => Object.freeze({
    term: entry.term, scores: Object.freeze({ ...entry.scores }),
  })),
);
export const EMOTION_DICTIONARY_COUNT = EMOTION_DICTIONARY.length;
