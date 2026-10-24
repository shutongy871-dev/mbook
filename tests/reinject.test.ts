import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  executeScript: vi.fn(),
}));
vi.mock('wxt/browser', () => ({
  browser: {
    tabs: { query: mocks.query, sendMessage: mocks.sendMessage },
    scripting: { executeScript: mocks.executeScript },
  },
}));

import { reinjectOpenWereadTabs } from '@/core/reading/reinject';

beforeEach(() => {
  mocks.query.mockReset();
  mocks.sendMessage.mockReset();
  mocks.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
  mocks.executeScript.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('content-script recovery after extension reload', () => {
  it('stops stale instances and injects MAIN then isolated scripts into every open WeRead tab', async () => {
    mocks.query.mockResolvedValue([{ id: 11 }, { id: 22 }, {}]);
    mocks.executeScript.mockResolvedValue([]);
    expect(await reinjectOpenWereadTabs()).toBe(2);
    expect(mocks.query).toHaveBeenCalledWith({ url: 'https://weread.qq.com/*' });
    expect(mocks.executeScript).toHaveBeenCalledTimes(6);
    expect(mocks.executeScript.mock.calls.map(([request]) => ({
      tabId: request.target.tabId, world: request.world, files: request.files,
    }))).toEqual([
      { tabId: 11, world: 'MAIN', files: undefined },
      { tabId: 11, world: 'MAIN', files: ['/content-scripts/weread-hook.js'] },
      { tabId: 11, world: undefined, files: ['/content-scripts/content.js'] },
      { tabId: 22, world: 'MAIN', files: undefined },
      { tabId: 22, world: 'MAIN', files: ['/content-scripts/weread-hook.js'] },
      { tabId: 22, world: undefined, files: ['/content-scripts/content.js'] },
    ]);
  });

  it('continues restoring other tabs when one tab closes during injection', async () => {
    mocks.query.mockResolvedValue([{ id: 11 }, { id: 22 }]);
    mocks.executeScript.mockImplementation(async request => {
      if (request.target.tabId === 11) throw new Error('No tab with id');
      return [];
    });
    expect(await reinjectOpenWereadTabs()).toBe(1);
    expect(mocks.executeScript.mock.calls.some(([request]) => request.target.tabId === 22)).toBe(true);
  });

  it('does not reinject when the existing collector answers the liveness probe', async () => {
    mocks.query.mockResolvedValue([{ id: 11 }]);
    mocks.sendMessage.mockResolvedValue({ alive: true });
    mocks.executeScript.mockResolvedValue([]);
    expect(await reinjectOpenWereadTabs()).toBe(0);
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });
});
