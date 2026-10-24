import { useEffect, useState } from 'react';
import {
  readingAnalysisRepo, type ReadingAnalysisRecord,
} from '@/core/db/reading-analysis.repo';
import { EMOTION_DIMENSIONS, EMOTION_LABELS } from '@/core/understanding/emotion-dictionary';

const PAGE_SIZE = 20;

export default function ReadingAnalysisPanel() {
  const [rows, setRows] = useState<ReadingAnalysisRecord[]>([]);
  const [summary, setSummary] = useState({ total: 0, hit: 0, zero: 0, failed: 0 });
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const nextSummary = await readingAnalysisRepo.summary();
        const lastPage = Math.max(0, Math.ceil(nextSummary.total / PAGE_SIZE) - 1);
        if (active && page > lastPage) { setPage(lastPage); return; }
        const nextRows = await readingAnalysisRepo.page(page * PAGE_SIZE, PAGE_SIZE);
        if (active) { setRows(nextRows); setSummary(nextSummary); setError(''); }
      } catch {
        if (active) setError('读取记录失败，请刷新或重新打开设置页。');
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [page, revision]);

  const exportRows = async () => {
    try {
      const records = await readingAnalysisRepo.all();
      const url = URL.createObjectURL(new Blob([
        JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2),
      ], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `mbook-reading-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('导出失败，请重试。'); }
  };

  const clear = async () => {
    if (!window.confirm('清空所有本地阅读命中记录？')) return;
    try {
      await readingAnalysisRepo.clear();
      setPage(0); setRevision(value => value + 1);
    } catch { setError('清空失败，请重试。'); }
  };

  return <section className="opt-card reading-analysis">
    <h2>阅读命中记录</h2>
    <p className="opt-sub">本地保留最近 1000 条、最多 30 天。</p>
    <div className="reading-summary">
      <span>窗口 {summary.total}</span>
      <span>有效命中 {summary.hit}</span>
      <span>全零 {summary.zero}</span>
      <span>失败 {summary.failed}</span>
    </div>
    <div className="opt-row">
      <button className="opt-btn opt-btn-ghost" onClick={() => setRevision(value => value + 1)}>刷新</button>
      <button className="opt-btn opt-btn-ghost" onClick={() => void exportRows()}>导出 JSON</button>
      <button className="opt-btn opt-btn-ghost" onClick={() => void clear()}>清空记录</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {loading ? <p>加载中…</p> : !rows.length && <p className="opt-sub">暂无记录。重新加载插件后，打开阅读页面并进入专注阅读状态。</p>}
    {rows.map(row => <details key={row.id} className="reading-record">
      <summary>
        {new Date(row.ts).toLocaleString()} · {row.title || '未命名页面'} ·
        {row.error ? '识别失败' : row.hasValidEmotion ? '有效情绪' : '全零'} ·
        {row.analysisSource === 'model' ? '模型' : row.analysisSource === 'llm_fused' ? '旧版融合' : '词典'}
      </summary>
      <p className="opt-sub">{row.chapter ?? '无章节'} · {row.textLength} 字 · {row.elapsedMs.toFixed(1)} ms ·
        当时歌曲：{row.trackTitle ?? '无'}（{row.trackId ?? '无'}）</p>
      <p className="opt-sub">窗口：{row.windowId ?? '无'} · {row.model || row.profile?.version}</p>
      {row.error ? <p role="alert">{row.error} · 已保留当前歌曲</p> :
        <p className="opt-sub">八维分数：{(row.matchingVector ?? row.profile?.vector)?.map(n => n.toFixed(3)).join(' / ')}</p>}
      {row.evidence && <p>{row.evidence}</p>}
      {row.selection && <p className="opt-sub">选歌结果：{row.selection.selectedTitle ?? row.selection.selectedId} ·
        {row.selection.reason} · 余弦 {row.selection.comparison?.cosine?.toFixed(3) ?? '无方向'} ·
        欧式距离 {row.selection.comparison?.euclideanDistance?.toFixed(3) ?? '无'} ·
        筛选轮次 {row.selection.attempts.length}</p>}
      {row.selection && <pre>{JSON.stringify(row.selection.attempts, null, 2)}</pre>}
      <p className="opt-sub reading-url">{row.url}</p>
      <pre className="reading-text">{row.text}</pre>
      {row.profile && <div className="reading-dimensions">
        {EMOTION_DIMENSIONS.map(dimension => {
          const result = row.profile!.dimensions[dimension];
          return <div key={dimension} className="reading-dimension">
            <b>{EMOTION_LABELS[dimension]} {result.score.toFixed(3)}</b>
            <span className="opt-sub">有效 {result.validHitCount} / 命中 {result.hitCount} · 累计 {result.sum.toFixed(3)}</span>
            {!result.evidence.length && <span className="opt-sub">未命中，补 0</span>}
            {result.evidence.map((evidence, index) => <div key={index} className="reading-evidence">
              <span>{evidence.expression} → {evidence.score.toFixed(3)}
                {evidence.excluded === 'negated' ? '（否定排除）' :
                  evidence.excluded === 'complex_negation' ? '（复杂否定排除）' : ''}
              </span>
              <span className="opt-sub">基础 {evidence.baseScore} × 程度 {evidence.multiplier} ·
                原文位置 {evidence.start}–{evidence.end}</span>
              <span className="opt-sub">{evidence.sentence}</span>
            </div>)}
          </div>;
        })}
      </div>}
    </details>)}
    <div className="opt-row">
      <button className="opt-btn opt-btn-ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</button>
      <span>第 {page + 1} / {Math.max(1, Math.ceil(summary.total / PAGE_SIZE))} 页</span>
      <button className="opt-btn opt-btn-ghost" disabled={(page + 1) * PAGE_SIZE >= summary.total}
        onClick={() => setPage(value => value + 1)}>下一页</button>
    </div>
  </section>;
}
