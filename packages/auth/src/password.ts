/**
 * Sifre hash'leme.
 *
 * bcrypt, cost 12 -- onceki projenin uretimde kanitli parametresiyle birebir
 * (apps/backend/src/modules/v1/common/auth/auth.service.ts). Kutuphane
 * bilincli olarak `bcryptjs` (saf JS): `bcrypt` npm paketi node-gyp ile
 * native derleme ister ve bu, `packages/sandbox` calismasinda zaten bir kez
 * pnpm allowBuilds surtunmesine yol actiginda ayni sinifta tekrar surtunme
 * yaratirdi. bcryptjs ayni hash formatini (`$2a$`/`$2b$`) uretir; native
 * bcrypt ile birebir uyumludur, ileride gerekirse acisiz gecis yapilabilir.
 */

import bcrypt from 'bcryptjs';

export const BCRYPT_COST = 12;
export const BCRYPT_MAX_PASSWORD_BYTES = 72;

export function passwordFitsBcryptLimit(password: string): boolean {
  return Buffer.byteLength(password, 'utf8') <= BCRYPT_MAX_PASSWORD_BYTES;
}

export async function hashPassword(plainPassword: string): Promise<string> {
  if (!passwordFitsBcryptLimit(plainPassword)) {
    throw new RangeError(`Parola en fazla ${BCRYPT_MAX_PASSWORD_BYTES} UTF-8 byte olabilir.`);
  }
  return bcrypt.hash(plainPassword, BCRYPT_COST);
}

/** Basarisizlikta false doner, istisna firlatmaz -- cagiran taraf try/catch'e zorlanmaz. */
export async function verifyPassword(plainPassword: string, storedHash: string): Promise<boolean> {
  if (!passwordFitsBcryptLimit(plainPassword)) return false;
  return bcrypt.compare(plainPassword, storedHash);
}

/**
 * Hesap bulunamadiginda bcrypt maliyetini YINE DE oder. Bilinmeyen e-postada
 * dogrulama hic kosmazsa yanit ~1 ms, bilinen hesapta ~250 ms surer ve bu sure
 * farki hesabin var olup olmadigini sizdirir. `hash` ile `compare` ayni
 * maliyeti (cost 12) tasir; sonuc atilir. Siniri asan parola `verifyPassword`
 * gibi bcrypt'e hic girmez.
 */
export async function burnPasswordCost(plainPassword: string): Promise<void> {
  if (!passwordFitsBcryptLimit(plainPassword)) return;
  await bcrypt.hash(plainPassword, BCRYPT_COST);
}
