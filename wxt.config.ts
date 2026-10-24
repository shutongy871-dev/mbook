import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'MBook',
    version: '0.1.0',
    description: 'AI 驱动的阅读实时动态 BGM',
    permissions: ['offscreen', 'storage', 'unlimitedStorage', 'alarms', 'cookies', 'scripting'],
    // 网易云曲库请求（SW 跨域 fetch 需 host 权限）；https://*/* 同时覆盖 BYOK LLM 端点
    host_permissions: [
      'https://*.music.126.com/*',
      'https://music.163.com/*',
      'https://*/*',
    ],
    web_accessible_resources: [{
      resources: ['wake-watchdog.js'],
      matches: ['https://weread.qq.com/*'],
    }],
  },
});
