/**
 * Yalniz gateway'in okudugu bayrak ortam degiskenleri (`SMITH_ALLOW_REGISTRATION`,
 * `SMITH_WS_DISABLE_LEGACY_TOKEN`). `@smith/env`'in `flagEnv` kuraliyla AYNI:
 * '1' | 'true' | 'on' acik; bos ve diger her deger kapali. Guvenlik bayraklarinda
 * yazim hatasi sessizce "acik" anlamina gelmesin diye bilincli olarak siki.
 */
export function isFlagOn(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true' || raw === 'on';
}
