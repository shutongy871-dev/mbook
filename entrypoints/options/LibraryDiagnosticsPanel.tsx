import { useEffect, useState } from 'react';
import { libraryDiagnosticsRepo } from '@/core/db/library-diagnostics.repo';
import {
  DIAGNOSTIC_LABELS, type DiagnosticCategory, type LibraryDiagnostics,
} from '@/core/matching/library-diagnostics';

const PAGE_SIZE = 20;
const time = (value: number | null) => value ? new Date(value).toLocaleString() : '无记录';

export default function LibraryDiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState<LibraryDiagnostics | null>(null);
  const [error, setError] = useState('');
  const [category, setCategory] = useState<DiagnosticCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await libraryDiagnosticsRepo.snapshot();
        if (active) { setSnapshot(next); setError(''); }
      } catch {
        if (active) setError('读取曲库诊断失败，请刷新或重新打开设置页。');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [revision]);

  const exportRows = async () => {
    try {
      const next = await libraryDiagnosticsRepo.snapshot();
      setSnapshot(next);
      const url = URL.createObjectURL(new Blob([JSON.stringify(next, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `mbook-library-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError('');
    } catch { setError('导出曲库诊断失败，请重试。'); }
  };
  const keyword = query.trim().toLowerCase();
  const filtered = snapshot?.rows.filter(row =>
    (category === 'all' || row.categories.includes(category)) &&
    `${row.title} ${row.artist} ${row.album} ${row.id}`.toLowerCase().includes(keyword)) ?? [];
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);

  return <section className="opt-card reading-analysis library-diagnostics">
    <h2>网易云曲库诊断</h2>
    <p className="opt-sub">按已保存的设置检查当前入库歌曲，每 5 秒刷新。待画像与无有效画像分开统计；
      其余原因可能重叠，各项不能直接相加。人声过滤包含尚未入池歌曲按当前策略会遇到的问题。</p>
    <p className="opt-sub">“可参与匹配”表示通过画像与硬过滤，实际选中取决于阅读八维；
      播放还需解析地址并成功加载。这里只统计仍在本地曲库中的网易云歌曲。</p>
    {snapshot && <>
      <div className="reading-summary">
        <span>入库 {snapshot.total}</span>
        <span>有阻挡（去重）{snapshot.blocked}</span>
        {Object.entries(DIAGNOSTIC_LABELS).map(([key, label]) =>
          <span key={key}>{label} {snapshot.counts[key as DiagnosticCategory]}</span>)}
      </div>
      <p className="opt-sub">诊断时间：{time(snapshot.generatedAt)} · 人声策略：
        {{ instrumental_only: '只要纯音乐', instrumental_preferred: '优先纯音乐', any: '不限制' }[snapshot.policy.lyric_policy]}
        · 网易云曲库{snapshot.policy.netease_enabled ? '已开启' : '已关闭'}</p>
    </>}
    <div className="opt-row">
      <button className="opt-btn opt-btn-ghost" onClick={() => setRevision(value => value + 1)}>刷新诊断</button>
      <button className="opt-btn opt-btn-ghost" onClick={() => void exportRows()}>导出全部逐首原因 JSON</button>
    </div>
    <label className="opt-field opt-field-inline">
      <span className="opt-label">筛选原因</span>
      <select value={category} onChange={event => { setCategory(event.target.value as typeof category); setPage(0); }}>
        <option value="all">全部歌曲</option>
        {Object.entries(DIAGNOSTIC_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>
    <label className="opt-field opt-field-inline">
      <span className="opt-label">搜索歌曲</span>
      <input type="text" value={query} placeholder="歌名、歌手、专辑或歌曲 ID"
        onChange={event => { setQuery(event.target.value); setPage(0); }} />
    </label>
    {error && <p role="alert">{error}</p>}
    {!snapshot && !error && <p>加载曲库诊断中…</p>}
    {snapshot && !filtered.length && <p className="opt-sub">{snapshot.total ? '没有符合筛选条件的歌曲。' : '暂无网易云入库歌曲，请登录并同步曲库。'}</p>}
    {filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(row =>
      <details key={row.id} className="reading-record">
        <summary>{row.title} · {row.artist} · {row.categories.map(key => DIAGNOSTIC_LABELS[key]).join(' / ')}</summary>
        <p className="opt-sub">{row.id} · 专辑：{row.album || '无'} · 画像状态：{row.profileStatus}</p>
        <p className="opt-sub">画像来源：{{ audio_model: '模型听音频', metadata: '歌名 / 标签等元数据', none: '尚无画像' }[row.profileSource]}</p>
        {row.audioJob && <details>
          <summary>听感识别记录 · {row.audioJob.status}</summary>
          <p>{row.audioJob.error}</p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(row.audioJob.result ?? {
            attempts: row.audioJob.attempts, updated_at: row.audioJob.updated_at,
          }, null, 2)}</pre>
        </details>}
        {row.eligible ? <p>已通过当前入池与硬过滤条件。</p> :
          <ul>{row.reasons.map(reason => <li key={reason.code}>{reason.message}</li>)}</ul>}
        {row.notes.map((note, index) => <p className="opt-sub" key={index}>{note}</p>)}
        <p className="opt-sub">八维顺序：喜悦 / 悲伤 / 温柔 / 希望 / 恐惧 / 愤怒 / 神秘 / 庄严</p>
        <p className="opt-sub">八维画像：{row.vector?.map(n => n.toFixed(3)).join(' / ') ?? '无合法八维向量'}</p>
        <p className="opt-sub">最近地址探测：{time(row.lastProbeAt)} · 最近画像尝试：{time(row.lastTagAttempt)}</p>
      </details>)}
    <div className="opt-row">
      <button className="opt-btn opt-btn-ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
      <span>筛选 {filtered.length} 首 · 第 {currentPage + 1} / {pageCount} 页</span>
      <button className="opt-btn opt-btn-ghost" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
    </div>
  </section>;
}
