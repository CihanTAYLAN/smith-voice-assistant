/**
 * Enum tipli motor ayari (izin modu, sandbox, makine). Bos deger "verilmedi"
 * demektir ve varsayilana duser; yazim hatasi ise ACILISTA reddedilir.
 * Sessizce baska bir degere dusmek (or. `plan` yerine yazma yetkili mod)
 * yapilandirma hatasini beklenmedik bir yetkiye cevirirdi.
 */
export function readAllowedEnv<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = process.env[key]?.trim();
  if (value === undefined || value === '') return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} gecersiz: ${value}. Izin verilenler: ${allowed.join(', ')}.`);
  }
  return value as T;
}

const DEFAULT_ENGINE_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_ENGINE_TIMEOUT_MS = 10_000;
const MAX_ENGINE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Motor zaman asimi ortam degeri (ms), iki motorun ortak okuyucusu. Bos deger
 * "verilmedi" demektir ve 15 dakikaya duser; tam sayi olmayan ya da
 * [10 sn, 2 saat] disindaki deger ACILISTA reddedilir (`readAllowedEnv` ile ayni
 * ilke). Eskiden `5000` gibi kisa bir deneme degeri ya da yazim hatasi sessizce
 * 15 dakikaya donuyor, kullanici kisa zaman asimini sandigi halde kosu 15 dakika
 * surebiliyordu.
 */
export function readTimeoutMsEnv(key: string): number {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_ENGINE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_ENGINE_TIMEOUT_MS || value > MAX_ENGINE_TIMEOUT_MS) {
    throw new Error(
      `${key} gecersiz: ${raw}. ${MIN_ENGINE_TIMEOUT_MS}-${MAX_ENGINE_TIMEOUT_MS} ms araliginda tam sayi olmali.`,
    );
  }
  return value;
}
