import { afterEach, describe, expect, it } from 'vitest';

import { isMissionExecutorEnabled } from './executor.js';

describe('isMissionExecutorEnabled', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('yalniz acikca "1" verildiginde aciktir (varsayilan kapali)', () => {
    delete process.env.SMITH_MISSION_EXECUTOR;
    expect(isMissionExecutorEnabled()).toBe(false);
    process.env.SMITH_MISSION_EXECUTOR = '0';
    expect(isMissionExecutorEnabled()).toBe(false);
    process.env.SMITH_MISSION_EXECUTOR = 'true';
    expect(isMissionExecutorEnabled()).toBe(false);
    process.env.SMITH_MISSION_EXECUTOR = '1';
    expect(isMissionExecutorEnabled()).toBe(true);
  });
});
