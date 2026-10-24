import { browser } from 'wxt/browser';
import { logger } from '@/core/shared/logger';

const WEREAD_MATCH = 'https://weread.qq.com/*';

// Chrome does not inject manifest content scripts into tabs that were already
// open when an extension was reloaded. Recreate both worlds without navigating
// the reader, so the user's position is preserved.
export async function reinjectOpenWereadTabs(): Promise<number> {
  const tabs = await browser.tabs.query({ url: WEREAD_MATCH });
  let restored = 0;
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      const response = await browser.tabs.sendMessage(tab.id, { type: 'MBOOK_CONTENT_PROBE' }) as { alive?: boolean } | undefined;
      if (response?.alive) continue;
    } catch {
      // Expected after extension reload: the old isolated world has no live receiver.
    }
    const target = { tabId: tab.id };
    try {
      await browser.scripting.executeScript({
        target,
        world: 'MAIN',
        func: async () => {
          window.postMessage({ type: 'MBOOK_CONTENT_RESTART' }, location.origin);
          window.postMessage({ type: 'MBOOK_WEREAD_STOP' }, location.origin);
          await new Promise(resolve => setTimeout(resolve, 75));
          document.getElementById('mbook-floating-ball')?.remove();
        },
      });
      await browser.scripting.executeScript({
        target,
        world: 'MAIN',
        files: ['/content-scripts/weread-hook.js'],
      });
      await browser.scripting.executeScript({
        target,
        files: ['/content-scripts/content.js'],
      });
      restored++;
    } catch (error) {
      logger.warn(`[reinject] 微信读书标签页 ${tab.id} 恢复失败`, error);
    }
  }
  return restored;
}
