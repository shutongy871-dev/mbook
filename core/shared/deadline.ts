// The caller's budget includes queue wait, not just fetch time.
// Abort prevents queued work from starting after the caller has already fallen back.
export async function withinDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>, budgetMs: number, fallback: T,
): Promise<T> {
  if (budgetMs <= 0) return fallback;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal).catch(() => fallback),
      new Promise<T>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(fallback); }, budgetMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
