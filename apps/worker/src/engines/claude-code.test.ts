import { afterEach, describe, expect, it } from 'vitest';

import { readEngineConfig } from './claude-code.js';

describe('readEngineConfig', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('gecersiz permission mode yazma yetkisine dusmez, fail-fast olur', () => {
    process.env.SMITH_MISSION_PERMISSION_MODE = 'paln';
    expect(() => readEngineConfig()).toThrow(/SMITH_MISSION_PERMISSION_MODE/);
  });

  it('bypassPermissions allowlist disindadir ve reddedilir', () => {
    process.env.SMITH_MISSION_PERMISSION_MODE = 'bypassPermissions';
    expect(() => readEngineConfig()).toThrow(/SMITH_MISSION_PERMISSION_MODE/);
  });

  it('verilmeyen ya da bos deger varsayilan acceptEdits olur; plan korunur', () => {
    delete process.env.SMITH_MISSION_PERMISSION_MODE;
    expect(readEngineConfig().permissionMode).toBe('acceptEdits');
    process.env.SMITH_MISSION_PERMISSION_MODE = '';
    expect(readEngineConfig().permissionMode).toBe('acceptEdits');
    process.env.SMITH_MISSION_PERMISSION_MODE = 'plan';
    expect(readEngineConfig().permissionMode).toBe('plan');
  });
});

describe('readEngineConfig zaman asimi', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('varsayilan 15 dakikadir; gecerli deger okunur', () => {
    delete process.env.SMITH_MISSION_TIMEOUT_MS;
    expect(readEngineConfig().timeoutMs).toBe(15 * 60 * 1000);
    process.env.SMITH_MISSION_TIMEOUT_MS = '420000';
    expect(readEngineConfig().timeoutMs).toBe(420_000);
  });

  it('kisa deneme degeri (5000) ve yazim hatasi sessizce 15 dakikaya dusmez, acilista reddedilir', () => {
    process.env.SMITH_MISSION_TIMEOUT_MS = '5000';
    expect(() => readEngineConfig()).toThrow(/SMITH_MISSION_TIMEOUT_MS gecersiz: 5000/);
    process.env.SMITH_MISSION_TIMEOUT_MS = '7dk';
    expect(() => readEngineConfig()).toThrow(/SMITH_MISSION_TIMEOUT_MS gecersiz: 7dk/);
  });
});
