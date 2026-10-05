import { describe, expect, it } from 'vitest';

import { generateRefreshToken, hashRefreshTokenCandidate } from './index.js';

describe('refresh token', () => {
  it('ham deger ve hash farklidir, hash geri cevrilemeyecek bicimdedir', () => {
    const issued = generateRefreshToken();
    expect(issued.token).not.toBe(issued.tokenHash);
    expect(issued.token.length).toBeGreaterThan(20);
  });

  it('aday token dogru hash e cevrilir', () => {
    const issued = generateRefreshToken();
    expect(hashRefreshTokenCandidate(issued.token)).toBe(issued.tokenHash);
  });

  it('family verilmezse yeni bir soy baslar', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.family).not.toBe(b.family);
  });

  it('family verilirse rotasyon boyunca korunur', () => {
    const first = generateRefreshToken();
    const rotated = generateRefreshToken(first.family);
    expect(rotated.family).toBe(first.family);
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.tokenHash).not.toBe(first.tokenHash);
  });

  it('iki uretim farkli ham token verir', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.token).not.toBe(b.token);
  });
});
