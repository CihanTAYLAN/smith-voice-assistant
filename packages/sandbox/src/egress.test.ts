import { describe, expect, it } from 'vitest';

import {
  allowlistEgress,
  assertEgressAllowed,
  blockedInfrastructureReason,
  denyAllEgress,
  EgressDeniedError,
  EgressPolicyError,
  evaluateEgress,
} from './index.js';

const OPEN = allowlistEgress({
  hosts: ['api.anthropic.com', '*.githubusercontent.com'],
  justification: 'model cagrisi ve depo icerigi',
});

describe('egress politikasi', () => {
  it('varsayilan kapalidir', () => {
    const verdict = evaluateEgress(denyAllEgress(), { host: 'api.anthropic.com' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe('deny-all');
  });

  it('allowlist gerekce olmadan uretilemez', () => {
    expect(() => allowlistEgress({ hosts: ['example.com'], justification: 'kisa' })).toThrow(
      EgressPolicyError,
    );
  });

  it('bos allowlist reddedilir', () => {
    expect(() => allowlistEgress({ hosts: [], justification: 'gerekce yeterince uzun' })).toThrow(
      EgressPolicyError,
    );
  });

  it('sema veya port iceren girdi reddedilir', () => {
    for (const host of ['https://example.com', 'example.com:443', 'example.com/path']) {
      expect(() => allowlistEgress({ hosts: [host], justification: 'yeterince uzun' })).toThrow(
        EgressPolicyError,
      );
    }
  });

  it('tam esleme ve joker calisir', () => {
    expect(evaluateEgress(OPEN, { host: 'api.anthropic.com' }).allowed).toBe(true);
    expect(evaluateEgress(OPEN, { host: 'raw.githubusercontent.com' }).allowed).toBe(true);
    expect(evaluateEgress(OPEN, { host: 'evil.com' }).allowed).toBe(false);
  });

  it('joker koku kapsamaz', () => {
    expect(evaluateEgress(OPEN, { host: 'githubusercontent.com' }).allowed).toBe(false);
  });

  it('sondaki nokta eslemeyi bozmaz', () => {
    expect(evaluateEgress(OPEN, { host: 'api.anthropic.com.' }).allowed).toBe(true);
  });
});

describe('altyapi korumasi', () => {
  it('loopback, ozel aralik ve bulut metadata adresini tanir', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '172.17.0.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      'localhost',
      'redis.internal',
    ]) {
      expect(blockedInfrastructureReason(host), host).not.toBeNull();
    }
  });

  it('genel adresleri engellemez', () => {
    for (const host of ['1.1.1.1', '93.184.216.34', 'api.anthropic.com', '2606:4700::1111']) {
      expect(blockedInfrastructureReason(host), host).toBeNull();
    }
  });

  it('altyapi hedefi allowlist e yazilamaz', () => {
    expect(() =>
      allowlistEgress({ hosts: ['127.0.0.1'], justification: 'yerel servise erisim' }),
    ).toThrow(EgressPolicyError);
  });

  /**
   * Bu testin varlik sebebi: hostname allowlist'i tek basina DNS rebinding'i
   * engellemez. Proxy cozulmus adresi vermek zorunda ve karar onu da tartmali.
   */
  it('allowlist te olsa cozulmus ic adres reddedilir', () => {
    const verdict = evaluateEgress(OPEN, {
      host: 'api.anthropic.com',
      resolvedIp: '127.0.0.1',
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe('infrastructure-guard');
  });

  it('server ic servisleri cozulmus adresle bile gecemez', () => {
    for (const ip of ['127.0.0.1', '172.17.0.1', '10.0.0.5']) {
      const verdict = evaluateEgress(OPEN, { host: 'api.anthropic.com', resolvedIp: ip });
      expect(verdict.rule, ip).toBe('infrastructure-guard');
    }
  });

  it('assertEgressAllowed reddi hata olarak firlatir', () => {
    expect(() => assertEgressAllowed(denyAllEgress(), { host: 'example.com' })).toThrow(
      EgressDeniedError,
    );
    expect(() => assertEgressAllowed(OPEN, { host: 'api.anthropic.com' })).not.toThrow();
  });
});
