import { describe, expect, it } from 'vitest';

import { isFlagOn } from './env-flags.js';

describe('isFlagOn', () => {
  it.each(['1', 'true', 'on'])('%s acik sayilir', (raw) => {
    expect(isFlagOn(raw)).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'off', 'yes', 'TRUE', ' 1', 'evet'])(
    '%j kapali sayilir (yalniz acik deger acar, yazim hatasi kapali birakir)',
    (raw) => {
      expect(isFlagOn(raw)).toBe(false);
    },
  );
});
