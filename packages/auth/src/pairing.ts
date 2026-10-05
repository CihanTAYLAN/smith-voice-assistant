/**
 * Cihaz eslestirme kodu: headless istemciler (CLI, Watch) icin.
 *
 * Akis: headless istemci bir kod ister -> kullaniciya gosterir (ekranda
 * veya terminalde) -> kullanici zaten oturum acmis bir istemcide (telefon,
 * web) kodu onaylar -> onaylayanin WorkspaceScope'u kopyalanir -> headless
 * istemci kodu tokenlara degistirir. openclaw'in `device-bootstrap.ts`
 * akisiyla (10 dakika TTL, tek kullanimlik, onay sonrasi degistirme) ayni
 * sekli bagimsiz olarak dogruluyor.
 *
 * Kod insan tarafindan yazilmak icin: 0/O, 1/I/L gibi karistirilabilir
 * karakterler alfabeden cikarilmistir.
 */

import { randomInt } from 'node:crypto';

import { hashOpaqueToken } from './hash.js';

export const PAIRING_CODE_TTL_SECONDS = 10 * 60;

const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_GROUP_SIZE = 4;

export interface IssuedPairingCode {
  /** Kullaniciya gosterilecek bicim: `XXXX-XXXX`. Sakla DEGIL, goster. */
  readonly code: string;
  readonly codeHash: string;
}

export function generatePairingCode(): IssuedPairingCode {
  let raw = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    raw += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  const code = `${raw.slice(0, PAIRING_CODE_GROUP_SIZE)}-${raw.slice(PAIRING_CODE_GROUP_SIZE)}`;
  return { code, codeHash: hashPairingCandidate(code) };
}

/** Kullanicinin kirdakla/bosluksuz/kucuk harfle yazmasina tolerans. */
export function normalizePairingCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function hashPairingCandidate(rawOrFormatted: string): string {
  return hashOpaqueToken(normalizePairingCode(rawOrFormatted));
}
