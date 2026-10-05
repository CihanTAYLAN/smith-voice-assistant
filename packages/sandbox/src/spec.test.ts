import { createWorkspaceScope } from '@smith/tenancy';
import { describe, expect, it } from 'vitest';

import {
  allowlistEgress,
  createSandboxSpec,
  denyAllEgress,
  RuntimeNotAllowedError,
  runtimeProfile,
  SandboxSpecError,
  secretRef,
  SecretRefError,
  type SandboxSpecInput,
} from './index.js';

const SCOPE = createWorkspaceScope({
  workspaceId: 'ws_abcdefghij0123456789',
  actorId: 'act_abcdefghij0123456789',
  role: 'member',
});

function baseInput(overrides: Partial<SandboxSpecInput> = {}): SandboxSpecInput {
  return {
    scope: SCOPE,
    runtime: runtimeProfile({ runtime: 'runsc' }),
    image: 'smith-sandbox:bookworm-slim',
    command: ['sleep', 'infinity'],
    egress: denyAllEgress(),
    ...overrides,
  };
}

describe('sandbox spec', () => {
  it('varsayilan olarak egress kapali ve kok dosya sistemi salt-okunur', () => {
    const spec = createSandboxSpec(baseInput(), 'production');
    expect(spec.egress.mode).toBe('deny-all');
    expect(spec.readOnlyRootFs).toBe(true);
  });

  it('etiketsiz imaj reddedilir', () => {
    expect(() => createSandboxSpec(baseInput({ image: 'smith-sandbox' }), 'production')).toThrow(
      SandboxSpecError,
    );
  });

  it('digest ile pinlenmis imaj kabul edilir', () => {
    const digest = `smith-sandbox@sha256:${'a'.repeat(64)}`;
    expect(() => createSandboxSpec(baseInput({ image: digest }), 'production')).not.toThrow();
  });

  it('bos komut reddedilir', () => {
    expect(() => createSandboxSpec(baseInput({ command: [] }), 'production')).toThrow(
      SandboxSpecError,
    );
  });

  it('negatif veya sifir kaynak tavani reddedilir', () => {
    expect(() => createSandboxSpec(baseInput({ limits: { timeoutMs: 0 } }), 'production')).toThrow(
      SandboxSpecError,
    );
  });

  it('goreli calisma alani yolu reddedilir', () => {
    expect(() =>
      createSandboxSpec(
        baseInput({ workspace: { containerPath: 'workspace', readOnly: false } }),
        'production',
      ),
    ).toThrow(SandboxSpecError);
  });

  /** Spec uretimi tek bogaz noktasi: runtime kapisi da burada kosar. */
  it('uretimde runc ile spec uretilemez', () => {
    expect(() =>
      createSandboxSpec(baseInput({ runtime: runtimeProfile({ runtime: 'runc' }) }), 'production'),
    ).toThrow(RuntimeNotAllowedError);
  });

  it('spec cagirana ait kopya dondurur, girdi mutasyonu sizmaz', () => {
    const command = ['sleep', 'infinity'];
    const spec = createSandboxSpec(baseInput({ command }), 'production');
    command.push('injected');
    expect(spec.command).toEqual(['sleep', 'infinity']);
  });
});

describe('sir sizintisina karsi kapilar', () => {
  it('env icinde sir gorunumlu anahtar reddedilir', () => {
    for (const key of ['GITHUB_TOKEN', 'DATABASE_URL_SECRET', 'my_api_key']) {
      expect(() => createSandboxSpec(baseInput({ env: { [key]: 'x' } }), 'production')).toThrow(
        SecretRefError,
      );
    }
  });

  it('zararsiz env anahtarlari gecer', () => {
    expect(() =>
      createSandboxSpec(baseInput({ env: { LANG: 'C.UTF-8', TERM: 'dumb' } }), 'production'),
    ).not.toThrow();
  });

  it('egress in izin vermedigi host a bagli sir reddedilir', () => {
    const ref = secretRef({
      name: 'github_token',
      injectAt: 'authorization-bearer',
      forHost: 'api.github.com',
    });
    expect(() => createSandboxSpec(baseInput({ secrets: [ref] }), 'production')).toThrow(
      SecretRefError,
    );
  });

  it('egress acikca izin verdiginde sir kabul edilir', () => {
    const ref = secretRef({
      name: 'github_token',
      injectAt: 'authorization-bearer',
      forHost: 'api.github.com',
    });
    const egress = allowlistEgress({
      hosts: ['api.github.com'],
      justification: 'depo okuma araci',
    });
    const spec = createSandboxSpec(baseInput({ secrets: [ref], egress }), 'production');
    expect(spec.secrets).toHaveLength(1);
  });
});
