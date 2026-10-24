import { browser } from 'wxt/browser';
import type { Cc0Track } from '@/core/shared/contracts';
import features from './features.json';

// 10 首真实 CC0 音乐节选（72s）；来源、作者、变更及 SHA-256 见 public/cc0/credits.json。
// 音频文件放在 public/cc0/ 下：构建时原样复制到扩展根目录 /cc0/，
// 不经过 Vite 打包（避免被 base64 内联进 background.js 导致包体积暴涨），
// 运行时通过 runtime.getURL 取 chrome-extension:// 绝对地址，各上下文均可访问。
// 八维初始人工配置（待听感校准），独立标注，不从旧数值转换。
export const CC0_TRACKS: Cc0Track[] = [
  {
    id: 'cc01',
    title: '静谧铺垫',
    mood_label: '温柔',
    mood_emoji: '😌',
    emotion: [0.1, 0, 0.25, 0.1, 0, 0, 0, 0],
    tags: ['平静舒缓'],
    url: browser.runtime.getURL('/cc0/cc01-calm.m4a'),
  },
  {
    id: 'cc02',
    title: '温暖午后',
    mood_label: '温柔',
    mood_emoji: '🫧',
    emotion: [0.3, 0, 0.75, 0.2, 0, 0, 0, 0],
    tags: ['温暖治愈'],
    url: browser.runtime.getURL('/cc0/cc02-warm.m4a'),
  },
  {
    id: 'cc03',
    title: '淡淡忧伤',
    mood_label: '悲伤',
    mood_emoji: '🌧️',
    emotion: [0, 0.75, 0.15, 0, 0, 0, 0.1, 0],
    tags: ['悲伤低落'],
    url: browser.runtime.getURL('/cc0/cc03-sad.m4a'),
  },
  {
    id: 'cc04',
    title: '暗流涌动',
    mood_label: '恐惧',
    mood_emoji: '🔶',
    emotion: [0, 0.1, 0, 0, 0.8, 0.1, 0.4, 0.1],
    tags: ['紧张悬疑'],
    url: browser.runtime.getURL('/cc0/cc04-tense.m4a'),
  },
  {
    id: 'cc05',
    title: '微光上扬',
    mood_label: '希望',
    mood_emoji: '🌱',
    emotion: [0.4, 0, 0.15, 0.8, 0, 0, 0, 0.1],
    tags: ['希望上扬'],
    url: browser.runtime.getURL('/cc0/cc05-hopeful.m4a'),
  },
  {
    id: 'cc06',
    title: '专注时刻',
    mood_label: '庄严',
    mood_emoji: '🎯',
    emotion: [0, 0, 0.1, 0.1, 0, 0, 0.15, 0.3],
    tags: ['专注沉浸'],
    url: browser.runtime.getURL('/cc0/cc06-focus.m4a'),
  },
  {
    id: 'cc07',
    title: '高潮推进',
    mood_label: '庄严',
    mood_emoji: '🔥',
    emotion: [0.15, 0, 0, 0.55, 0.1, 0.35, 0.1, 0.85],
    tags: ['高潮燃向'],
    url: browser.runtime.getURL('/cc0/cc07-epic.m4a'),
  },
  {
    id: 'cc08',
    title: '迷雾深处',
    mood_label: '神秘',
    mood_emoji: '🌫️',
    emotion: [0, 0.1, 0, 0, 0.3, 0, 0.8, 0.15],
    tags: ['神秘未知'],
    url: browser.runtime.getURL('/cc0/cc08-mystery.m4a'),
  },
  {
    id: 'cc09',
    title: '夜晚松弛',
    mood_label: '温柔',
    mood_emoji: '🌙',
    emotion: [0.1, 0.1, 0.35, 0, 0, 0, 0.1, 0],
    tags: ['夜晚松弛'],
    url: browser.runtime.getURL('/cc0/cc09-night.m4a'),
  },
  {
    id: 'cc10',
    title: '稳定底噪',
    mood_label: '未识别到情绪',
    mood_emoji: '⚪',
    emotion: [0, 0, 0, 0, 0, 0, 0, 0],
    tags: ['中性底噪'],
    url: browser.runtime.getURL('/cc0/cc10-bed.m4a'),
  },
].map(track => ({
  ...track,
  artist: ['cc04', 'cc06', 'cc07', 'cc08'].includes(track.id) ? 'Alexander Ehlers' : 'Juhani Junkala',
  bpm: features[track.id as keyof typeof features].bpm,
  duration_sec: 72,
  bitrate_kbps: 96,
}));

export function getCc0Track(id: string): Cc0Track | undefined {
  return CC0_TRACKS.find((t) => t.id === id);
}
