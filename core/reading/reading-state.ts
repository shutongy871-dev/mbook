import type { ReadingStateName } from '@/core/shared/contracts';

// 阈值与技术方案 6.2 节一致，集中在此便于后续调参
export const READING_THRESHOLDS = {
  STAY_MIN_SEC: 3, // 停留至少 3 秒才算在读
  SCROLL_SPEED_MAX_SPS: 0.35, // 滚动速度上限（屏/秒），超过视为快速浏览
  VISIBLE_TEXT_MIN: 80, // 视口内可见正文至少 80 字
  CPM_MIN: 150, // 专注阅读速度下限（字/分钟）
  CPM_MAX: 900, // 专注阅读速度上限（字/分钟），超过视为扫读
} as const;

export interface ReadingSignals {
  page_active: boolean;
  stay_sec: number;
  scroll_speed_sps: number;
  visible_text_len: number;
  reading_speed_cpm: number;
  reading_speed_known?: boolean;
}

export interface ReadingJudgement {
  state: ReadingStateName;
  is_reading: boolean;
}

// 纯函数：由原始信号判定阅读三态，不碰 DOM、不碰消息，方便单测
export function judgeReadingState(s: ReadingSignals): ReadingJudgement {
  // 切走标签页 / 窗口最小化 → 未激活
  if (!s.page_active) {
    return { state: 'inactive', is_reading: false };
  }

  const is_reading =
    s.stay_sec >= READING_THRESHOLDS.STAY_MIN_SEC &&
    s.scroll_speed_sps <= READING_THRESHOLDS.SCROLL_SPEED_MAX_SPS &&
    s.visible_text_len >= READING_THRESHOLDS.VISIBLE_TEXT_MIN;

  // 在读且阅读速度落在真人阅读区间 → 专注；其余可见情况一律算浏览
  // （停留太短 / 滚太快 / 正文太少 / 速度超 900 或慢于 150 都不触发后续理解）
  const focused =
    is_reading &&
    (s.reading_speed_known === false ||
      (s.reading_speed_cpm >= READING_THRESHOLDS.CPM_MIN &&
        s.reading_speed_cpm <= READING_THRESHOLDS.CPM_MAX));

  return {
    state: focused ? 'focused' : 'scanning',
    is_reading,
  };
}
