// BYOK LLM 客户端（OpenAI 兼容 /chat/completions）
import { z } from 'zod';
import { logger } from '@/core/shared/logger';
import { readAudioStream } from './qwen-audio';

export const LlmConfigSchema = z.object({
  llm_endpoint: z.string().default(''),
  llm_key: z.string().default(''),
  llm_model: z.string().default(''),
});

export function isLlmConfigured(cfg: {
  llm_endpoint: string;
  llm_key: string;
}): boolean {
  return Boolean(cfg.llm_endpoint.trim() && cfg.llm_key.trim());
}

export function apiUrl(endpoint: string, resource: 'chat/completions' | 'embeddings'): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  const root = base.replace(/\/(?:chat\/completions|embeddings)$/, '');
  const url = new URL(/\/v\d+$/.test(root) ? `${root}/${resource}` : `${root}/v1/${resource}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址需为不含凭据及查询参数的 HTTPS 地址');
  }
  return url.href;
}

export function safeLlmError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '请求超时';
  if (error instanceof Error && error.message === '请求超时') return '请求超时';
  if (error instanceof Error && /^LLM HTTP \d{3}$/.test(error.message)) return error.message;
  return '服务地址、网络或响应格式异常';
}

// 提取模型 JSON 输出（兼容 ```json 包裹）
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse((raw ?? text).trim());
}

export async function chatJson(
  cfg: { llm_endpoint: string; llm_key: string; llm_model: string },
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 8000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl(cfg.llm_endpoint, 'chat/completions'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.llm_key.trim()}`,
      },
      body: JSON.stringify({
        model: cfg.llm_model.trim() || 'gpt-4o-mini',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}`);
    }
    if (res.headers?.get('content-type')?.includes('text/event-stream')) {
      const { text } = await readAudioStream(res);
      return extractJson(text);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 返回为空');
    return extractJson(content);
  } catch (e) {
    logger.warn('[llm] 调用失败:', safeLlmError(e));
    throw new Error(safeLlmError(e));
  } finally {
    clearTimeout(timer);
  }
}
