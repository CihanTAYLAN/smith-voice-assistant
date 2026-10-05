import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRefreshReplayCache,
  REFRESH_REPLAY_MAX_ENTRIES,
  REFRESH_ROTATION_GRACE_MS,
  type RefreshReplay,
} from './auth-refresh-replay.js';

function replay(family: string, suffix: string): RefreshReplay {
  return {
    family,
    replacementHash: `hash-${suffix}`,
    body: { accessToken: `access-${suffix}`, refreshToken: `refresh-${suffix}` },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRefreshReplayCache', () => {
  it('tolerans icinde ilk yaniti dondurur, sure dolunca unutur', () => {
    const cache = createRefreshReplayCache();
    cache.remember('eski', replay('soy-1', '1'));

    expect(cache.recall('eski')?.body.refreshToken).toBe('refresh-1');
    vi.advanceTimersByTime(REFRESH_ROTATION_GRACE_MS - 1);
    expect(cache.recall('eski')).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(cache.recall('eski')).toBeUndefined();
  });

  it('forgetFamily ayni soydaki tum kayitlari siler, baska soyu korur', () => {
    const cache = createRefreshReplayCache();
    cache.remember('a', replay('soy-1', 'a'));
    cache.remember('b', replay('soy-1', 'b'));
    cache.remember('c', replay('soy-2', 'c'));

    cache.forgetFamily('soy-1');

    expect(cache.recall('a')).toBeUndefined();
    expect(cache.recall('b')).toBeUndefined();
    expect(cache.recall('c')).toBeDefined();
  });

  it('ayni token yeniden hatirlanirsa eski zamanlayici yeni kaydi silmez', () => {
    const cache = createRefreshReplayCache();
    cache.remember('eski', replay('soy-1', '1'));
    vi.advanceTimersByTime(20_000);
    cache.remember('eski', replay('soy-1', '2'));

    vi.advanceTimersByTime(REFRESH_ROTATION_GRACE_MS - 5_000);
    expect(cache.recall('eski')?.body.refreshToken).toBe('refresh-2');
  });

  it('tablo dolunca en eski kaydi atar', () => {
    const cache = createRefreshReplayCache();
    for (let i = 0; i < REFRESH_REPLAY_MAX_ENTRIES; i += 1) {
      cache.remember(`token-${i}`, replay('soy', String(i)));
    }

    cache.remember('yeni', replay('soy', 'yeni'));

    expect(cache.recall('token-0')).toBeUndefined();
    expect(cache.recall('token-1')).toBeDefined();
    expect(cache.recall('yeni')).toBeDefined();
  });
});
