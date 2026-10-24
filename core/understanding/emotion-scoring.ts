import {
  EMOTION_DICTIONARY, EMOTION_DIMENSIONS, EMOTION_PROFILE_VERSION,
  type EmotionDimension,
} from './emotion-dictionary';

export interface EmotionEvidence {
  term: string;
  expression: string;
  sentence: string;
  start: number; // 原文 UTF-16 偏移，end 为开区间
  end: number;
  sentenceIndex: number;
  baseScore: number;
  multiplier: number;
  score: number;
  excluded: 'negated' | 'complex_negation' | null;
}
export interface EmotionDimensionScore {
  score: number; // 有效命中强度均值，0～1；无有效证据补0。
  sum: number; // 累计贡献，仅用于证据检查，不作为匹配强度。
  unknown: boolean; // 是否缺少有效证据；补0后仍保留此标记供核查。
  evidence: EmotionEvidence[];
  strongestEvidence: EmotionEvidence | null;
  hitCount: number;
  validHitCount: number;
  sentenceCount: number;
}
export interface EmotionProfile {
  version: string;
  vector: number[]; // 固定八维顺序；无有效命中的维度补0。
  dimensions: Record<EmotionDimension, EmotionDimensionScore>;
  matchedExpressionCount: number; // 多维词条只计一次，最长词优先、不重叠
}

const byTerm = new Map(EMOTION_DICTIONARY.map(entry => [entry.term, entry]));
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patternSource = [...byTerm.keys()].sort((a, b) => b.length - a.length)
  .map(escapePattern).join('|');
const degreePattern = /(有点|有些|有一点|略微|稍微|非常|十分|极其)(?:的|地)?$/;
const negationPattern = /(不再|不曾|没有|并非|毫无|并不|从未|未曾|不是|不|非|未|无)(?:感到|觉得|感受|很)?$/;
const complexNegationPattern = /(?:不是不|并非不|没有不|不得不|不能不|不无)(?:感到|觉得|很)?$/;

function emptyDimension(): EmotionDimensionScore {
  return {
    score: 0, sum: 0, unknown: true, evidence: [], strongestEvidence: null,
    hitCount: 0, validHitCount: 0, sentenceCount: 0,
  };
}

// Selector 纯函数：每次贡献=min(1,基础分×程度系数)，每维取有效贡献均值。
// SQL 等效：维度表LEFT JOIN有效证据，SELECT dimension, COALESCE(AVG(LEAST(1, base_score * multiplier)), 0),
// SUM(LEAST(1, base_score * multiplier))
// FROM evidence WHERE excluded IS NULL GROUP BY dimension;
// 未命中维度补0，否定不进入分母。累计值仅保留作证据。
export function scoreTextEmotions(text: string): EmotionProfile {
  const dimensions: Record<EmotionDimension, EmotionDimensionScore> = {
    joy: emptyDimension(), sadness: emptyDimension(), tenderness: emptyDimension(),
    hope: emptyDimension(), fear: emptyDimension(), anger: emptyDimension(),
    mystery: emptyDimension(), solemnity: emptyDimension(),
  };
  let matchedExpressionCount = 0;
  let sentenceIndex = 0;
  // 保留原文句子和偏移；逗号/转折隔开修饰作用域，但证据展示完整句子。
  for (const sentenceMatch of text.matchAll(/[^。！？!?；;\r\n]+[。！？!?；;]?/g)) {
    const sentence = sentenceMatch[0];
    const sentenceStart = sentenceMatch.index!;
    for (const match of sentence.matchAll(new RegExp(patternSource, 'g'))) {
      matchedExpressionCount++;
      const term = match[0];
      const entry = byTerm.get(term)!;
      const termIndex = match.index!;
      const before = sentence.slice(0, termIndex);
      const clause = before.split(/[，,：:。！？!?；;]|但是|然而|不过|却|但/).at(-1) ?? '';
      let prefix = clause;
      let modifierLength = 0;
      let multiplier = 1;
      const degree = degreePattern.exec(prefix);
      if (degree) {
        multiplier = /^(有点|有些|有一点|略微|稍微)/.test(degree[0]) ? .5 : 1.5;
        modifierLength += degree[0].length;
        prefix = prefix.slice(0, degree.index);
      }
      const complex = complexNegationPattern.exec(prefix);
      const negation = negationPattern.exec(prefix);
      const excluded = complex ? 'complex_negation' : negation ? 'negated' : null;
      if (complex || negation) modifierLength += (complex ?? negation)![0].length;
      const start = sentenceStart + termIndex - modifierLength;
      const end = sentenceStart + termIndex + term.length;
      for (const dimension of EMOTION_DIMENSIONS) {
        const baseScore = entry.scores[dimension];
        if (!baseScore) continue;
        const evidence: EmotionEvidence = {
          term, expression: text.slice(start, end), sentence, start, end,
          sentenceIndex, baseScore, multiplier,
          score: excluded ? 0 : Math.min(1, baseScore * multiplier), excluded,
        };
        const result = dimensions[dimension];
        result.evidence.push(evidence);
        result.hitCount++;
        if (!excluded) {
          result.validHitCount++;
          result.sum += evidence.score;
          result.unknown = false;
          if (!result.strongestEvidence || evidence.score > result.strongestEvidence.score) {
            result.strongestEvidence = evidence;
          }
        }
      }
    }
    sentenceIndex++;
  }
  for (const dimension of EMOTION_DIMENSIONS) {
    const result = dimensions[dimension];
    if (result.validHitCount) result.score = result.sum / result.validHitCount;
    dimensions[dimension].sentenceCount = new Set(
      dimensions[dimension].evidence.filter(e => !e.excluded).map(e => e.sentenceIndex),
    ).size;
  }
  return { version: EMOTION_PROFILE_VERSION,
    vector: EMOTION_DIMENSIONS.map(dimension => dimensions[dimension].score),
    dimensions, matchedExpressionCount };
}

// 零向量没有方向，返回null；禁止伪造相似度。只接受固定八维非负有限分数。
export function emotionCosineSimilarity(a: readonly (number | null)[], b: readonly (number | null)[]): number | null {
  if (a.length !== EMOTION_DIMENSIONS.length || b.length !== EMOTION_DIMENSIONS.length ||
    ![...a, ...b].every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)) return null;
  const aa = a as readonly number[], bb = b as readonly number[];
  // 先按最大值缩放，避免合法的大累计分在平方时溢出。
  const maxA = Math.max(...aa), maxB = Math.max(...bb);
  if (!maxA || !maxB) return null;
  const scaledA = aa.map(x => x / maxA), scaledB = bb.map(x => x / maxB);
  const norm = Math.hypot(...scaledA) * Math.hypot(...scaledB);
  return Math.max(0, Math.min(1, scaledA.reduce((sum, x, i) => sum + x * scaledB[i]!, 0) / norm));
}
