/**
 * Saglayici yedekleme zincirinin karar mantigi.
 *
 * NEDEN: 2026-08-25'te canli tool-loop testi Gemini free-tier'da UC ayri kiple
 * dustu — 429 (kota), 503 (yuk) ve en sinsisi STALL (yanit hic gelmedi, istemci
 * 120 sn sonra zaman asimina ugradi). Tek saglayiciya bagli bir asistan bu
 * ucunde de sessizce olur. Zincir bunu cozer, ama YALNIZ dogru siniflandirmayla:
 *
 *  - Gecici ariza (kota/yuk/ag/zaman asimi) → SONRAKI saglayiciya gec.
 *  - Kalici ariza (400/401/403/404: bizim istegimiz ya da anahtarimiz bozuk) →
 *    HEMEN patla. Bunlarda yedege dusmek arizayi MASKELER: `thought_signature`
 *    bug'i tam olarak bir 400'du; zincir onu yutsaydi "Gemini calismiyor"
 *    diye yanlis teshise gomulurduk (bkz. ADR 0008 istisnasi).
 *  - Kullanici iptali → asla yedege dusme, aynen yukari birak.
 */

/** Gecici sayilan HTTP durumlari: tekrar denemek anlamli. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Gecici sayilan ag hatasi kodlari (status tasimazlar). */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Saglayici hatalari `LlmError`'a sarilir; gercek sebep `cause` zincirindedir. */
function unwrap(error: unknown, depth = 0): unknown[] {
  if (depth > 5 || error === null || typeof error !== 'object') return [error];
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? [error] : [error, ...unwrap(cause, depth + 1)];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** HTTP durumunu (varsa) hata zincirinden cikarir. */
export function extractStatus(error: unknown): number | undefined {
  for (const link of unwrap(error)) {
    if (link === null || typeof link !== 'object') continue;
    const candidate =
      readNumber((link as { status?: unknown }).status) ??
      readNumber((link as { statusCode?: unknown }).statusCode);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/**
 * Bu hatada SONRAKI saglayiciya gecmek anlamli mi?
 * Bilinmeyen hatalarda `false` doner: sessizce yedege dusup gercek bug'i
 * gizlemektense gorunur bicimde patlamak yeglenir (fail-loud).
 */
export function isRetryableLlmError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);

  for (const link of unwrap(error)) {
    if (link === null || typeof link !== 'object') continue;
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;
    const name = (link as { name?: unknown }).name;
    // OpenAI SDK: baglanti/zaman asimi hatalari status tasimaz.
    if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  }
  return false;
}

/** Bir denemenin zaman asimi. Stall'i (yanit hic gelmemesi) yakalayan sey budur. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 45_000;
