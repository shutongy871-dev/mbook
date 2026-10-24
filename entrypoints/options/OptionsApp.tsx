import { useEffect, useState } from 'react';
import { settingsRepo, DEFAULT_SETTINGS } from '@/core/db/settings.repo';
import { sendToBackground } from '@/core/shared/messaging';
import { modelConfigError } from '@/core/llm/model-config';
import type { Settings } from '@/core/shared/contracts';
import ModelSettingsPanel from './ModelSettingsPanel';
import ReadingAnalysisPanel from './ReadingAnalysisPanel';
import LibraryDiagnosticsPanel from './LibraryDiagnosticsPanel';
import AudioEmotionPanel from './AudioEmotionPanel';

export default function OptionsApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<'settings' | 'music' | 'records'>('settings');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  useEffect(() => { void settingsRepo.get().then(setSettings); }, []);
  if (!settings) return <div className="opt-loading">加载设置中…</div>;
  const patch = (value: Partial<Settings>) => {
    setSettings(current => current ? { ...current, ...value } : current);
    setSaved(false); setError('');
  };
  const save = async (): Promise<boolean> => {
    for (const model of settings.models ?? []) {
      if (!settings.text_model_id && !settings.music_model_id) continue;
      const invalid = modelConfigError(model);
      if (invalid) { setError(`${model.name || model.model || '模型'}：${invalid}`); setTab('settings'); return false; }
    }
    setSaving(true);
    try {
      // 只发送可编辑字段。运行时派生的旧配置字段不参与保存，避免双份密钥。
      const { llm_endpoint: _a, llm_key: _b, llm_model: _c, ai_strength: _d,
        song_audio_enabled: _e, song_audio_endpoint: _f, song_audio_key: _g, song_audio_model: _h, ...value } = settings;
      const response = await sendToBackground({ type: 'UPDATE_SETTINGS', patch: value });
      if (!response?.ok) throw new Error();
      setSettings(await settingsRepo.get());
      setSaved(true); setError('');
      return true;
    } catch { setError('保存失败，请重新打开设置后重试。'); return false; }
    finally { setSaving(false); }
  };
  const reset = async () => {
    const response = await sendToBackground({ type: 'UPDATE_SETTINGS', patch: {
      ...DEFAULT_SETTINGS, models: [], text_model_id: null, music_model_id: null,
    } }).catch(() => null);
    if (!response?.ok) { setError('恢复默认失败'); return; }
    setSettings(await settingsRepo.get()); setSaved(true); setError('');
  };
  const sync = async () => {
    const result = await sendToBackground({ type: 'SYNC_MUSIC' }).catch(() => null);
    setSyncMessage(result?.ok ? '同步已启动' : '同步失败，请重试');
  };
  return <main className="opt-page">
    <header className="settings-header"><div><h1 className="opt-title">MBook 设置</h1>
      <p className="opt-sub">让音乐跟随阅读。</p></div></header>
    <nav className="settings-tabs" aria-label="设置分类">
      {([['settings', '常用设置'], ['music', '音乐画像'], ['records', '记录与诊断']] as const).map(([id, label]) =>
        <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status" className="opt-saved">已保存</p>}
    {tab === 'settings' && <>
      <ModelSettingsPanel settings={settings} patch={patch} />
      <section className="opt-card">
        <h2>阅读与播放</h2>
        <Toggle label="专注阅读时自动播放" checked={settings.autoplay} onChange={v => patch({ autoplay: v })} />
        <Toggle label="离开 30 秒后暂停" checked={settings.auto_pause} onChange={v => patch({ auto_pause: v })} />
        <Toggle label="显示悬浮球" checked={settings.floating_ball} onChange={v => patch({ floating_ball: v })} />
        <label className="opt-field"><span className="opt-label">音量 <b>{settings.base_volume}%</b></span>
          <input type="range" min={0} max={100} value={settings.base_volume}
            onChange={e => patch({ base_volume: Number(e.target.value) })} /></label>
        <label className="opt-field opt-field-inline"><span className="opt-label">人声偏好</span>
          <select value={settings.lyric_policy} onChange={e => patch({ lyric_policy: e.target.value as Settings['lyric_policy'] })}>
            <option value="instrumental_only">只要纯音乐</option><option value="instrumental_preferred">优先纯音乐</option>
            <option value="any">不限制</option></select></label>
      </section>
      <section className="opt-card">
        <div className="section-heading"><h2>网易云曲库</h2>
          <button className="opt-btn opt-btn-ghost" onClick={() => void sync()}>同步曲库</button></div>
        <Toggle label="使用网易云歌曲" checked={settings.netease_enabled} onChange={v => patch({ netease_enabled: v })} />
        <p className="opt-sub">{syncMessage || '在网易云网页版登录后，即可同步歌单。'}</p>
      </section>
      <details className="opt-card advanced-settings">
        <summary>高级设置</summary>
        <div className="advanced-fields">
          <Toggle label="通过关键词搜索补充曲库" checked={settings.netease_search_supplement ?? false}
            onChange={v => patch({ netease_search_supplement: v })} />
          <label className="opt-field"><span className="opt-label">风格黑名单</span>
            <input type="text" value={settings.style_blacklist.join(',')} placeholder="说唱,金属"
              onChange={e => patch({ style_blacklist: e.target.value.split(/[,，]/) })} /></label>
          {([
            ['window_size', '阅读窗口字数', 150, 600, 50],
            ['update_interval_sec', '分析间隔（秒）', 3, 15, 1],
            ['fade_in_ms', '淡入时间（毫秒）', 500, 3000, 100],
            ['fade_out_ms', '淡出时间（毫秒）', 500, 3000, 100],
            ['vocal_penalty', '人声额外惩罚', 0, .5, .05],
          ] as const).map(([key, label, min, max, step]) => <label className="opt-field" key={key}>
            <span className="opt-label">{label} <b>{settings[key]}</b></span>
            <input type="range" min={min} max={max} step={step} value={settings[key]}
              onChange={e => patch({ [key]: Number(e.target.value) })} /></label>)}
          {(['calm', 'peak'] as const).map(kind => <div className="opt-field" key={kind}>
            <span className="opt-label">{kind === 'calm' ? '舒缓' : '高潮'}场景 BPM 范围</span>
            <div className="opt-row">{[0, 1].map(index => <input aria-label={`${kind} BPM ${index ? '上限' : '下限'}`}
              type="number" min={30} max={240} key={index} value={settings.bpm_ranges[kind][index]}
              onChange={e => {
                const range: [number, number] = [...settings.bpm_ranges[kind]];
                range[index] = Number(e.target.value);
                patch({ bpm_ranges: { ...settings.bpm_ranges, [kind]: range } });
              }} />)}</div></div>)}
          <details><summary>数据与模型调用</summary>
            <p className="opt-sub">Key 仅存本地。使用模型时，阅读片段或音乐采样会发送给配置的服务并产生 API 费用。
              未勾选文字识别时使用本地词典；模型失败时保留当前歌曲，原因可在记录中查看。</p></details>
          <button className="opt-btn opt-btn-ghost" onClick={() => void reset()}>恢复默认设置</button>
        </div>
      </details>
    </>}
    {tab === 'music' && <AudioEmotionPanel settings={settings} patch={patch} save={save} />}
    {tab === 'records' && <>
      <details className="opt-card diagnostics-section"><summary>阅读识别记录</summary><ReadingAnalysisPanel /></details>
      <details className="opt-card diagnostics-section"><summary>音乐识别诊断</summary>
        <AudioEmotionPanel settings={settings} patch={patch} save={save} diagnostics /></details>
      <details className="opt-card diagnostics-section"><summary>网易云曲库诊断</summary><LibraryDiagnosticsPanel /></details>
    </>}
    <footer className="settings-savebar">
      <div className="settings-savebar-inner">
        <button className="opt-btn opt-btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存设置'}</button>
      </div>
    </footer>
  </main>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="opt-toggle"><span className="opt-toggle-text">{label}</span>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /></label>;
}
