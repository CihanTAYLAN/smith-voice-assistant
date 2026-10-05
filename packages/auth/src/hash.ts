import { createHash } from 'node:crypto';

/**
 * Yuksek entropili opak degerler (refresh token, eslestirme kodu) icin
 * hash. Sifre DEGIL -- sifreler password.ts'teki yavas KDF'i kullanir. Bu
 * degerler zaten rastgele ve yuksek entropili oldugu icin yavas bir KDF
 * gereksizdir; tehdit modeli farklidir (sozluk saldirisi degil, veritabani
 * sizintisinda ham degerin oku(namamasi)).
 */
export function hashOpaqueToken(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}
