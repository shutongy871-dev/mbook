const PREFIX = '[MBook]';

export const logger = {
  debug: (...args: unknown[]) => console.debug(PREFIX, ...args),
  info: (...args: unknown[]) => console.log(PREFIX, ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
};
