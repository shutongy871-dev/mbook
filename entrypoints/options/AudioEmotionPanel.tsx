import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { db } from '@/core/db/dexie';
import { audioBudget } from '@/core/db/audio-jobs.repo';
import type { AudioTagBudget, AudioTagJob, Settings } from '@/core/shared/contracts';

const LABELS = { queued: '排队', processing: '识别中', complete: '完成', unknown: '未知', failed: '失败' };
export default function AudioEmotionPanel({ settings, patch, save, diagnostics = false }: {
  settings: Settings; patch: (patch: Partial<Settings>) => void; save: () => Promise<boolean>; diagnostics?: boolean;
}) {
  const [jobs, setJobs] = useState<AudioTagJob[]>([]);
  const [budget, setBudget] = useState<AudioTagBudget>({ attempts: 0 });
  const [songs, setSongs] = useState<Array<{ id: string; title: string }>>([]);
  const [songId, setSongId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const model = settings.models?.find(m => m.id === settings.music_model_id);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const nextJobs = await db.audioJobs.toArray();
        const nextBudget = await audioBudget();
        const nextSongs = diagnostics ? await db.songs.toArray() : [];
        if (alive) {
          setJobs(nextJobs.sort((a, b) => b.updated_at - a.updated_at)); setBudget(nextBudget);
          setSongs(nextSongs.map(s => ({ id: s.song_id, title: `${s.title} · ${s.artist}` })));
        }
      } catch { if (alive) setMessage('读取任务记录失败，请刷新设置页'); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [diagnostics]);
  const start = async (single: boolean) => {
    setBusy(true);
    try {
      if (!await save()) return;
      const response = await browser.runtime.sendMessage({ type: 'AUDIO_TAG_START', ...(single ? { songId } : {}) });
      if (!response?.ok) throw new Error(response?.error ?? '启动失败');
      setMessage(response.queued ? `已加入 ${response.queued} 首` : response.cached ? '已复用已有画像' : '继续处理已有队列');
    } catch (error) { setMessage(error instanceof Error ? error.message : '启动失败'); }
    finally { setBusy(false); }
  };
  if (!diagnostics) return <section className="opt-card" id="audio-emotion">
    <h2>音乐识别</h2>
    <p className="opt-sub">{model ? `使用 ${model.model}` : '先在模型配置中勾选“音乐识别”。'}</p>
    <div className="reading-summary">
      <span>已尝试 {budget.attempts} / {settings.song_audio_limit}</span>
      {Object.entries(LABELS).map(([key, name]) => <span key={key}>{name} {jobs.filter(j => j.status === key).length}</span>)}
    </div>
    <div className="opt-row">
      <button className="opt-btn opt-btn-primary" disabled={busy || !model} onClick={() => void start(false)}>开始批处理</button>
    </div>
    {message && <p role="status">{message}</p>}
    {budget.halted && <p role="alert">{budget.halted}。队列已暂停，修正模型配置后可继续。</p>}
    <details className="reading-record"><summary>批处理设置</summary>
      <label className="opt-field"><span className="opt-label">累计尝试上限（含失败）</span>
        <input type="number" min={1} max={5000} value={settings.song_audio_limit}
          onChange={e => patch({ song_audio_limit: Number(e.target.value) })} /></label>
      <p className="opt-sub">每首采样最多 60 秒。成功结果会复用，失败需手动重试；调用费用由模型服务商收取。</p>
    </details>
  </section>;
  return <section className="opt-card" id="audio-diagnostics">
    <h2>音乐识别诊断</h2>
    <p className="opt-sub">查看逐首八维分数、失败原因，或单独验证一首歌。</p>
    <label className="opt-field"><span className="opt-label">选择歌曲</span>
      <select aria-label="选择歌曲" value={songId} onChange={e => setSongId(e.target.value)}>
        <option value="">选择已同步的歌曲</option>
        {songs.map(song => <option key={song.id} value={song.id}>{song.title}</option>)}</select></label>
    <div className="opt-row">
      <button className="opt-btn opt-btn-ghost" disabled={busy || !songId || !model} onClick={() => void start(true)}>识别这一首</button>
    </div>
    {message && <p role="status">{message}</p>}
    <details className="reading-record"><summary>查看识别记录（{jobs.length}）</summary>
      {jobs.slice(0, 20).map(job => <details className="reading-record" key={job.song_id}>
        <summary>{songs.find(s => s.id === job.song_id)?.title ?? job.song_id} · {LABELS[job.status]}</summary>
        {job.error && <p>{job.error}</p>}
        <p className="opt-sub">{new Date(job.updated_at).toLocaleString()} · 尝试 {job.attempts} 次</p>
        {job.result && <>
          <p>八维：{job.result.emotion?.map(n => n.toFixed(3)).join(' / ') ?? '未知，保留原画像'}</p>
          {job.result.segments.map(s => <p className="opt-sub" key={s.index}>
            {s.start_sec.toFixed(1)}～{(s.start_sec + s.duration_sec).toFixed(1)} 秒：{s.evidence}
            {' · '}{s.emotion?.map(n => n.toFixed(2)).join(' / ') ?? '未知'}</p>)}
          {job.result.usage && <p className="opt-sub">输入 {job.result.usage.input_tokens} tokens
            （音频 {job.result.usage.audio_tokens ?? '未返回'}），输出 {job.result.usage.output_tokens} tokens</p>}
        </>}
      </details>)}
      {jobs.length > 20 && <p className="opt-sub">更多记录可在曲库诊断中查看。</p>}
    </details>
  </section>;
}
