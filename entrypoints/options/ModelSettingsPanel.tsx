import { useRef, useState } from 'react';
import type { ModelConfig, Settings } from '@/core/shared/contracts';
import { diagnoseLlm } from '@/core/llm/diagnostics';
import { modelConfigError } from '@/core/llm/model-config';

const EMPTY_MODEL: ModelConfig = {
  id: 'shared-model', name: '', endpoint: '', api_key: '', model: 'qwen3.8-omni-flash',
};

export default function ModelSettingsPanel({ settings, patch }: {
  settings: Settings; patch: (value: Partial<Settings>) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [check, setCheck] = useState('');
  const revision = useRef(0);
  const model = settings.models?.[0] ?? EMPTY_MODEL;
  const update = (value: Partial<ModelConfig>) => {
    revision.current++;
    patch({ models: [{ ...model, ...value }] });
    setCheck('');
  };
  const enable = (task: 'text_model_id' | 'music_model_id', checked: boolean) => {
    patch({ models: [model], [task]: checked ? model.id : null });
  };
  const test = async () => {
    const invalid = modelConfigError(model);
    if (invalid) { setCheck(invalid); return; }
    setTesting(true);
    const startedRevision = revision.current;
    try {
      const [result] = await diagnoseLlm({ ...settings, llm_endpoint: model.endpoint,
        llm_key: model.api_key, llm_model: model.model, embedding_model: '' });
      if (startedRevision === revision.current)
        setCheck(result ? `${result.message} · ${(result.elapsed_ms / 1000).toFixed(1)} 秒` : '检测失败');
    } finally { setTesting(false); }
  };
  return <section className="opt-card" id="model-settings">
    <h2>模型配置</h2>
    <label className="opt-field"><span className="opt-label">模型名</span>
      <input type="text" value={model.model} placeholder="qwen3.8-omni-flash"
        onChange={e => update({ model: e.target.value, name: '' })} /></label>
    <label className="opt-field"><span className="opt-label">接口地址（Base URL）</span>
      <input type="text" value={model.endpoint} placeholder="OpenAI 兼容地址"
        onChange={e => update({ endpoint: e.target.value })} /></label>
    <label className="opt-field"><span className="opt-label">API Key</span>
      <input type="password" autoComplete="off" value={model.api_key}
        onChange={e => update({ api_key: e.target.value })} /></label>
    <div className="model-uses" role="group" aria-label="模型用途">
      <label><input type="checkbox" checked={Boolean(settings.text_model_id)}
        onChange={e => enable('text_model_id', e.target.checked)} />文字识别</label>
      <label><input type="checkbox" checked={Boolean(settings.music_model_id)}
        onChange={e => enable('music_model_id', e.target.checked)} />音乐识别</label>
    </div>
    <div className="opt-row">
      <button className="opt-btn opt-btn-ghost" disabled={testing}
        title="发送固定短句验证八维输出，可能产生少量 API 费用" onClick={() => void test()}>
        {testing ? '检测中…' : '测试连接'}</button>
      {check && <span role="status" className="opt-sub">{check}</span>}
    </div>
  </section>;
}
