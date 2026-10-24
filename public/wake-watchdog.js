(() => {
  const key = '__MBOOK_WAKE_WATCHDOG__';
  const existing = window[key];
  if (existing) {
    existing.lease = Date.now();
    return;
  }
  const source = document.currentScript?.src;
  if (!source) return;
  const state = {
    lease: Date.now(),
    reloading: false,
  };
  window[key] = state;
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin &&
      event.data?.type === 'MBOOK_WEREAD_LEASE') state.lease = Date.now();
  });
  setInterval(() => {
    if (document.visibilityState !== 'visible' || Date.now() - state.lease <= 10_000 || state.reloading) return;
    state.reloading = true;
    setTimeout(() => {
      if (Date.now() - state.lease > 12_000) location.reload();
      else state.reloading = false;
    }, 2000);
  }, 5000);
})();
