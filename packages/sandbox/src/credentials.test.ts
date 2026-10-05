import { describe, expect, it } from 'vitest';

import {
  assertNoSecretsInEnv,
  describeSecretRef,
  secretRef,
  SecretRefError,
  toSecretName,
} from './index.js';

describe('sir referansi', () => {
  it('gecersiz sir adi reddedilir', () => {
    for (const name of ['A', 'Token', 'a', '1token', 'token-with-dash']) {
      expect(() => toSecretName(name), name).toThrow(SecretRefError);
    }
    expect(toSecretName('github_token')).toBe('github_token');
  });

  /** Joker bir sirri her hedefe acar; tam da onlemek istedigimiz sey. */
  it('joker hedef reddedilir', () => {
    expect(() =>
      secretRef({
        name: 'github_token',
        injectAt: 'authorization-bearer',
        forHost: '*.github.com',
      }),
    ).toThrow(SecretRefError);
  });

  it('bos hedef reddedilir', () => {
    expect(() =>
      secretRef({ name: 'github_token', injectAt: 'authorization-bearer', forHost: '  ' }),
    ).toThrow(SecretRefError);
  });

  it("injectAt='header' gecerli bir header adi ister", () => {
    expect(() =>
      secretRef({ name: 'api_key', injectAt: 'header', forHost: 'api.example.com' }),
    ).toThrow(SecretRefError);
    expect(() =>
      secretRef({
        name: 'api_key',
        injectAt: 'header',
        header: 'X-Api-Key',
        forHost: 'api.example.com',
      }),
    ).not.toThrow();
  });

  it('header adi yalnizca header enjeksiyonunda verilir', () => {
    expect(() =>
      secretRef({
        name: 'api_key',
        injectAt: 'basic-auth',
        header: 'X-Api-Key',
        forHost: 'api.example.com',
      }),
    ).toThrow(SecretRefError);
  });

  it('tanim ciktisi yalnizca referans bilgisi tasir', () => {
    const ref = secretRef({
      name: 'github_token',
      injectAt: 'authorization-bearer',
      forHost: 'api.github.com',
    });
    expect(describeSecretRef(ref)).toBe('github_token -> api.github.com (authorization-bearer)');
  });
});

describe('env temizligi', () => {
  it('sir gorunumlu anahtar yakalanir', () => {
    expect(() => assertNoSecretsInEnv({ ANTHROPIC_API_KEY: 'x' })).toThrow(SecretRefError);
  });

  it('temiz env gecer', () => {
    expect(() => assertNoSecretsInEnv({ HOME: '/home/sandbox', LANG: 'C.UTF-8' })).not.toThrow();
  });
});
