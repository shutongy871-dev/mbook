import { resolveBackupUrls, resolvePlayableUrl } from './index';

export interface RoutedUrl { url: string; bitrate: number }

// Primary and backup address lookups share one caller-controlled budget.
// An uncached NetEase request normally needs substantially longer than 100ms.
export async function routePlayableUrl(songId: string, budgetMs = 2500): Promise<RoutedUrl | null> {
  if (budgetMs <= 0) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const valid = async (request: Promise<RoutedUrl | null>): Promise<RoutedUrl> => {
    const result = await request;
    if (!result?.url) throw new Error('No playable address');
    controller.signal.throwIfAborted();
    return result;
  };
  try {
    return await Promise.race([
      Promise.any([
        valid(resolvePlayableUrl(songId, controller.signal)),
        valid(resolveBackupUrls(songId, controller.signal, 1).then(urls =>
          urls[0] ? { url: urls[0], bitrate: 0 } : null)),
      ]).catch(() => null),
      new Promise<null>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort(); // Stop the losing lookup; it must not update a late address.
  }
}
