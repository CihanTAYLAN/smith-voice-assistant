import { afterEach, describe, expect, it } from 'vitest';

import { readAllowedEnv, readTimeoutMsEnv } from './engine-config.js';

const MODES = ['plan', 'read-only', 'workspace-write'] as const;
const KEY = 'SMITH_TEST_ENGINE_MODE';

describe('readAllowedEnv', () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it.each([undefined, '', '   '])('verilmeyen deger (%j) varsayilana duser', (value) => {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    expect(readAllowedEnv(KEY, MODES, 'plan')).toBe('plan');
  });

  it('izin verilen degeri (bosluklari kirparak) dondurur', () => {
    process.env[KEY] = ' workspace-write ';
    expect(readAllowedEnv(KEY, MODES, 'plan')).toBe('workspace-write');
  });

  it('yazim hatasini sessizce baska degere dusurmez, anahtar adiyla reddeder', () => {
    process.env[KEY] = 'paln';
    expect(() => readAllowedEnv(KEY, MODES, 'plan')).toThrow(
      `${KEY} gecersiz: paln. Izin verilenler: plan, read-only, workspace-write.`,
    );
  });
});

describe('readTimeoutMsEnv', () => {
  const TIMEOUT_KEY = 'SMITH_TEST_ENGINE_TIMEOUT_MS';

  afterEach(() => {
    delete process.env[TIMEOUT_KEY];
  });

  it.each([undefined, '', '   '])('verilmeyen deger (%j) 15 dakika varsayilana duser', (value) => {
    if (value === undefined) delete process.env[TIMEOUT_KEY];
    else process.env[TIMEOUT_KEY] = value;
    expect(readTimeoutMsEnv(TIMEOUT_KEY)).toBe(15 * 60 * 1000);
  });

  it.each([
    ['10000', 10_000],
    [' 420000 ', 420_000],
    ['7200000', 7_200_000],
  ])('%j gecerli aralikta oldugu gibi okunur', (raw, expected) => {
    process.env[TIMEOUT_KEY] = raw;
    expect(readTimeoutMsEnv(TIMEOUT_KEY)).toBe(expected);
  });

  it.each(['5000', '9999', '0', '-1', '7200001', '1.5', '15m', 'abc', 'NaN', 'Infinity'])(
    '%j sessizce varsayilana dusmez: anahtar adiyla ve aralikla acilista reddedilir',
    (raw) => {
      process.env[TIMEOUT_KEY] = raw;
      expect(() => readTimeoutMsEnv(TIMEOUT_KEY)).toThrow(
        new RegExp(`${TIMEOUT_KEY} gecersiz: ${raw}.*10000.*7200000`),
      );
    },
  );
});
