import { logger } from './logger';

// 扩展重载/休眠后常见的通道失效错误，必须静默吞掉，不弹原生报错
export function isExtensionContextError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /context invalidated|context destroyed|receiving end does not exist|message port closed|extension context/i.test(
    msg,
  );
}

export async function safeCall<T>(
  fn: () => Promise<T>,
  fallback: T,
  label = '',
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isExtensionContextError(e)) {
      logger.debug(`safeCall[${label}] 通道失效，已跳过`);
    } else {
      logger.warn(`safeCall[${label}] 失败:`, e);
    }
    return fallback;
  }
}
