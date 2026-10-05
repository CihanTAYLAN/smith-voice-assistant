import { describe, expect, it } from 'vitest';

import { generatePairingCode, hashPairingCandidate, normalizePairingCode } from './index.js';

const AMBIGUOUS = ['0', 'O', '1', 'I', 'L'];

describe('eslestirme kodu', () => {
  it('XXXX-XXXX bicimindedir ve karistirilabilir karakter icermez', () => {
    const { code } = generatePairingCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    for (const bad of AMBIGUOUS) {
      expect(code).not.toContain(bad);
    }
  });

  it('yeterli sayida uretimde hepsi ayni cikmaz', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generatePairingCode().code));
    expect(codes.size).toBeGreaterThan(1);
  });

  it('normalize kucuk harf, bosluk ve tireyi tolere eder', () => {
    expect(normalizePairingCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizePairingCode('  ABCD 2345  ')).toBe('ABCD2345');
    expect(normalizePairingCode('ABCD2345')).toBe('ABCD2345');
  });

  it('bicimli ve normalize edilmemis ayni kod ayni hash i uretir', () => {
    const { code, codeHash } = generatePairingCode();
    expect(hashPairingCandidate(code.toLowerCase().replace('-', ' '))).toBe(codeHash);
  });

  it('farkli kodlar farkli hash uretir', () => {
    const a = generatePairingCode();
    const b = generatePairingCode();
    expect(a.codeHash).not.toBe(b.codeHash);
  });
});
