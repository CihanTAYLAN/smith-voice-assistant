import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';

import {
  BCRYPT_COST,
  burnPasswordCost,
  hashPassword,
  passwordFitsBcryptLimit,
  verifyPassword,
} from './index.js';

describe('sifre hash', () => {
  it('bcrypt formatinda ve dogru cost ile uretir', async () => {
    const hash = await hashPassword('dogru-at-nal');
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(hash).toContain(`$${BCRYPT_COST}$`);
  });

  it('ayni sifre iki farkli hash uretir (tuz)', async () => {
    const a = await hashPassword('aynen-boyle');
    const b = await hashPassword('aynen-boyle');
    expect(a).not.toBe(b);
  });

  it('dogru sifreyi dogrular', async () => {
    const hash = await hashPassword('gizli-parola-1');
    expect(await verifyPassword('gizli-parola-1', hash)).toBe(true);
  });

  it('yanlis sifreyi reddeder, istisna firlatmaz', async () => {
    const hash = await hashPassword('gizli-parola-1');
    expect(await verifyPassword('baska-bir-sey', hash)).toBe(false);
  });

  it('72 siniri karakter degil UTF-8 byte olarak sayilir', () => {
    expect(passwordFitsBcryptLimit('a'.repeat(72))).toBe(true);
    expect(passwordFitsBcryptLimit('a'.repeat(73))).toBe(false);
    expect(passwordFitsBcryptLimit('\u20ac'.repeat(24))).toBe(true); // 24 x 3 byte = 72
    expect(passwordFitsBcryptLimit('\u20ac'.repeat(25))).toBe(false); // 75 byte
  });

  it('hashPassword siniri asan parolayi reddeder', async () => {
    await expect(hashPassword('a'.repeat(73))).rejects.toThrow('72 UTF-8 byte');
  });

  it('bcrypt 72. byte sonrasini yok sayar: verifyPassword uzun parolayi reddeder', async () => {
    const hash = await hashPassword('a'.repeat(72));
    const longer = `${'a'.repeat(72)}x`;

    // Onkosul: bcrypt kendi basina sonu farkli bu parolayi dogru sayardi.
    expect(await bcrypt.compare(longer, hash)).toBe(true);
    expect(await verifyPassword(longer, hash)).toBe(false);
  });
});

describe('burnPasswordCost', () => {
  it('hesap yokken de cost 12 bcrypt isini GERCEKTEN yapar (sure ve cagri)', async () => {
    // Gercek bcrypt calisir (spy gecirir); yalniz cagri argumanlari ve sure olculur.
    const hashSpy = vi.spyOn(bcrypt, 'hash');
    const started = performance.now();

    await burnPasswordCost('herhangi-parola');

    expect(hashSpy).toHaveBeenCalledWith('herhangi-parola', BCRYPT_COST);
    // cost 12 saf JS bcrypt yuzlerce ms surer; 50 ms alti "hic calismadi" demektir.
    expect(performance.now() - started).toBeGreaterThan(50);
    hashSpy.mockRestore();
  });

  it('72 byte ustu girdide verifyPassword gibi bcrypt calistirmaz', async () => {
    const hashSpy = vi.spyOn(bcrypt, 'hash');

    await burnPasswordCost('a'.repeat(73));

    expect(hashSpy).not.toHaveBeenCalled();
    hashSpy.mockRestore();
  });
});
