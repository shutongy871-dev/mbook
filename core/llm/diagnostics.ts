import type { Settings } from '@/core/shared/contracts';
import { chatJson, isLlmConfigured, safeLlmError } from './client';
import { requestEmbedding } from './embedding';
import { TEXT_EMOTION_SYSTEM, TextEmotionSchema, TEXT_TIMEOUT_MS } from '@/core/understanding/text-llm';

export interface ServiceCheck {
  name: string;
  ok: boolean;
  elapsed_ms: number;
  message: string;
}

// User initiated, fixed samples only. No key, endpoint, reading text or raw response in reports.
export async function diagnoseLlm(settings: Settings): Promise<ServiceCheck[]> {
  if (!isLlmConfigured(settings)) return [{ name: '配置', ok: false, elapsed_ms: 0, message: '请填写接口地址和 API Key' }];
  const checks: ServiceCheck[] = [];
  const start = performance.now();
  try {
    const raw = await chatJson(settings, TEXT_EMOTION_SYSTEM, '阅读片段：微风拂过湖面，他平静地坐在树下休息。', TEXT_TIMEOUT_MS);
    const parsed = TextEmotionSchema.safeParse(raw);
    const elapsed_ms = Math.round(performance.now() - start);
    checks.push({ name: '聊天与情绪格式', ok: parsed.success, elapsed_ms,
      message: parsed.success ? '连接正常，八维输出格式通过' : '返回内容未通过八维格式校验' });
  } catch (e) { checks.push({ name: '聊天与情绪格式', ok: false, elapsed_ms: Math.round(performance.now() - start), message: safeLlmError(e) }); }
  if (!settings.embedding_model?.trim()) {
    checks.push({ name: '语义向量', ok: false, elapsed_ms: 0, message: '未配置 Embedding 模型，语义向量停用' });
    return checks;
  }
  const embeddingStart = performance.now();
  try {
    const vector = await requestEmbedding('平静舒缓的音乐，微风与湖面。', settings, 8000);
    const elapsed_ms = Math.round(performance.now() - embeddingStart);
    checks.push({ name: '语义向量', ok: true, elapsed_ms,
      message: `${vector.length} 维有效向量；${elapsed_ms <= 1500 ? '本次满足 1.5 秒预算' : '本次超过 1.5 秒，阅读时将降级'}` });
  } catch (e) { checks.push({ name: '语义向量', ok: false, elapsed_ms: Math.round(performance.now() - embeddingStart), message: safeLlmError(e) }); }
  return checks;
}
