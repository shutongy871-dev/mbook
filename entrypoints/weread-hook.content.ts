import { defineContentScript } from 'wxt/utils/define-content-script';
import { extractApiParagraphs } from '@/core/reading/weread-bridge';
import { installWereadCanvasCapture } from '@/core/reading/weread-canvas';

export default defineContentScript({
  matches: ['https://weread.qq.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const stopCanvasCapture = installWereadCanvasCapture();
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const urls = new WeakMap<XMLHttpRequest, string>();
    let alive = true;
    let lease = Date.now();
    const matches = (url: string) => {
      try {
        const parsed = new URL(url, location.href);
        return parsed.origin === location.origin && /\/(web\/book\/chapter|web\/book\/content|chapter\/content)/.test(parsed.pathname);
      } catch { return false; }
    };
    function publish(value: unknown, pageUrl: string) {
      if (!alive || pageUrl !== location.href) return;
      const paragraphs = extractApiParagraphs(value);
      if (paragraphs.length && paragraphs.join('').length <= 250000) {
        window.postMessage({ type: 'MBOOK_WEREAD_TEXT', url: pageUrl, paragraphs }, location.origin);
      }
    }
    const fetchHook: typeof fetch = async function (this: Window, ...args) {
      const pageUrl = location.href;
      const response = await originalFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      if (alive && matches(url)) void response.clone().text().then((text) => {
        if (text.length <= 250000) { try { publish(JSON.parse(text), pageUrl); } catch { /* 加密响应回退 DOM */ } }
      }).catch(() => {});
      return response;
    };
    const openHook: XMLHttpRequest['open'] = function (this: XMLHttpRequest, method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
      urls.set(this, String(url));
      return originalOpen.call(this, method, url, async, username, password);
    };
    const sendHook = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
      const pageUrl = location.href;
      if (matches(urls.get(this) ?? '')) this.addEventListener('load', () => {
        if (!alive) return;
        try {
          if (this.responseType === 'json') publish(this.response, pageUrl);
          else if ((!this.responseType || this.responseType === 'text') && this.responseText.length <= 250000) publish(JSON.parse(this.responseText), pageUrl);
        } catch { /* 保留 DOM 路径 */ }
      }, { once: true });
      return originalSend.apply(this, args);
    };
    function onLease(event: MessageEvent) {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.type === 'MBOOK_WEREAD_LEASE') lease = Date.now();
      if (event.data?.type === 'MBOOK_WEREAD_STOP') stop();
    }
    function stop() {
      alive = false;
      stopCanvasCapture();
      if (window.fetch === fetchHook) window.fetch = originalFetch;
      if (XMLHttpRequest.prototype.open === openHook) XMLHttpRequest.prototype.open = originalOpen;
      if (XMLHttpRequest.prototype.send === sendHook) XMLHttpRequest.prototype.send = originalSend;
      window.removeEventListener('message', onLease);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      clearInterval(watchdog);
    }
    function onPageHide(event: PageTransitionEvent) {
      // BFCache 会冻结脚本；保留 hook，恢复时续租。真正卸载才撤销。
      if (!event.persisted) stop();
    }
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) lease = Date.now();
    }
    window.fetch = fetchHook;
    XMLHttpRequest.prototype.open = openHook;
    XMLHttpRequest.prototype.send = sendHook;
    window.addEventListener('message', onLease);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    const watchdog = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const staleFor = Date.now() - lease;
      if (staleFor > 60_000) stop();
    }, 5000);
  },
});
