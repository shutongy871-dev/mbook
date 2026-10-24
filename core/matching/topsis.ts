// ===== TOPSIS 理想解距离（方案 6.5）=====
// 多指标向量归一后，计算每首歌距"理想解"（各指标全最好）与"最差解"（各指标全最差）
// 的距离，TopsisScore = D- / (D+ + D-)：越接近理想解、越远离最差解，分越高。
// T0 指标全部为效益型（越大越好）。

export interface TopsisItem {
  id: string;
  metrics: number[]; // 与列顺序一致的指标值（百分制）
}

export interface TopsisResult {
  id: string;
  score: number; // 0-100
}

export function topsis(items: TopsisItem[]): TopsisResult[] {
  if (items.length === 0) return [];
  const first = items[0];
  if (!first) return [];
  const colCount = first.metrics.length;
  const cell = (m: number[], c: number): number => m[c] ?? 0;

  // 1) 向量归一化：每列除以该列模长
  const norms = Array.from({ length: colCount }, (_, c) =>
    Math.sqrt(items.reduce((sum, it) => sum + cell(it.metrics, c) ** 2, 0)),
  );
  const normalized = items.map((it) => ({
    id: it.id,
    row: it.metrics.map((v, c) => (norms[c] ? v / (norms[c] as number) : 0)),
  }));

  // 2) 理想解 / 最差解（效益型：列最大 / 列最小）
  const ideal = Array.from({ length: colCount }, (_, c) =>
    Math.max(...normalized.map((n) => cell(n.row, c))),
  );
  const worst = Array.from({ length: colCount }, (_, c) =>
    Math.min(...normalized.map((n) => cell(n.row, c))),
  );

  // 3) 距离与贴近度
  return normalized
    .map((n) => {
      let dPlus = 0;
      let dMinus = 0;
      for (let c = 0; c < colCount; c++) {
        const v = cell(n.row, c);
        dPlus += (v - (ideal[c] as number)) ** 2;
        dMinus += (v - (worst[c] as number)) ** 2;
      }
      const dp = Math.sqrt(dPlus);
      const dm = Math.sqrt(dMinus);
      return { id: n.id, score: dp + dm > 0 ? (dm / (dp + dm)) * 100 : 50 };
    })
    .sort((a, b) => b.score - a.score);
}
