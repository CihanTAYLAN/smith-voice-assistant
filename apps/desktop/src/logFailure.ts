/**
 * Hata ayrintisinin gunluge (console) MASKELI yazilmasi.
 *
 * Kullaniciya ham hata metni gosterilmez: kisa Turkce mesaj gider. Teknik
 * ayrinti yalniz buraya yazilir ve sir/kisisel yol maskelenir; Rust komut
 * hatalari ve tarayici hatalari yerel yol, anahtar ya da belirtec tasiyabilir.
 * Maskeleme en iyi gayret esasli bir emniyet agidir, yetki siniri degildir.
 */

const MAX_DETAIL_LENGTH = 300;

const MASKS: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer xxx`: baslik adi ile kimlik bilgisi birlikte gider.
  [/\b(authorization)\s*[=:]\s*(?:bearer\s+|basic\s+)?\S+/gi, '$1=***'],
  // Basliksiz `bearer xxx`.
  [/\bbearer\s+\S+/gi, 'bearer ***'],
  // `anahtar=deger` ve `anahtar: deger` bicimleri.
  [/\b(token|secret|password|passwd|api[_-]?key)\b\s*[=:]\s*\S+/gi, '$1=***'],
  // Uzun opak diziler: API anahtarlari, JWT parcalari, uzun hex/base64 degerleri.
  [/[A-Za-z0-9_-]{32,}/g, '***'],
  // Kullanici ana dizini (Windows ve Unix): yol yapisi kalir, ad gider.
  [/([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1***'],
  [/(\/(?:Users|home)\/)[^/\s]+/g, '$1***'],
];

/** Metindeki bilinen sir ve ana dizin kaliplarini maskeler. */
export function maskSecrets(text: string): string {
  return MASKS.reduce(
    (masked, [pattern, replacement]) => masked.replace(pattern, replacement),
    text,
  );
}

/** Herhangi bir hata degerinin maskeli, kisaltilmis tek satirlik aciklamasi. */
export function describeError(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : 'bilinmeyen hata';
  return maskSecrets(raw.replace(/\s+/g, ' ')).slice(0, MAX_DETAIL_LENGTH);
}

/** `[kapsam] ayrinti` bicimiyle console'a yazar. */
export function logFailure(scope: string, error: unknown): void {
  console.error(`[${scope}] ${describeError(error)}`);
}
