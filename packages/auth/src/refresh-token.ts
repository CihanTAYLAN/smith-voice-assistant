/**
 * Refresh token: uzun omurlu, opak, veritabaninda YALNIZ hash'i tutulur.
 *
 * `family`: rotasyon boyunca sabit kalan soy kimligi. Bir refresh token
 * kullanildiginda YENI bir token + AYNI family ile degistirilir (rotate);
 * eski token iptal edilir. Iptal edilmis bir token tekrar sunulursa bu
 * calinti sinyalidir -- meshru istemci zaten rotasyonu tamamlamis, elindeki
 * tek gecerli token yenisi olmali. O sinyalde cagiran taraf ayni family'deki
 * TUM token'lari iptal etmelidir (@smith/db repos/auth.ts
 * revokeRefreshTokenFamily) -- onceki projenin uretimde kanitli deseni.
 *
 * Ham deger yalniz uretim aninda cagirana donen; saklanan hash'ten geri
 * cevrilemez. @smith/sandbox/credentials.ts'teki "sir asla deger olarak
 * saklanmaz" disiplininin ayni uygulamasi.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { hashOpaqueToken } from './hash.js';

export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IssuedRefreshToken {
  /** Cagirana bir kez donen ham deger. Sakla DEGIL, hemen ilet. */
  readonly token: string;
  /** Veritabaninda saklanacak SHA-256 hash. */
  readonly tokenHash: string;
  readonly family: string;
}

/** `existingFamily` verilmezse yeni bir soy baslar (ilk giris). */
export function generateRefreshToken(existingFamily?: string): IssuedRefreshToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashOpaqueToken(token),
    family: existingFamily ?? randomUUID(),
  };
}

/** Sunulan ham token'i, veritabaninda aranacak hash'e cevirir. */
export function hashRefreshTokenCandidate(token: string): string {
  return hashOpaqueToken(token);
}
