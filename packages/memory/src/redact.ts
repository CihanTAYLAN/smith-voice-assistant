/**
 * Uzak modele (embedding, ozet LLM) gitmeden ONCE yerelde secret maskeleme.
 *
 * Neden burada: "ozete secret yazma" promptu, girdinin buluta gitmis olmasini
 * geri alamaz; tek savunma, metin makineden cikmadan once secret'i silmektir.
 * Saglayici token desenleri `scripts/scan-secrets.sh` ile BIRLIKTE yasar:
 * redact.test.ts ikisinin ayrismasini yakalar (Gemini anahtari bir kez tam
 * da tarayici tanimadigi icin sizmisti).
 *
 * Masaustundeki `agent_sessions.rs::maskele` (Rust, oturum ciktisi icin) AYRI
 * bir uygulamadir: dagarcik benzer ama kod paylasmazlar; birini genisletirken
 * digerine de bak.
 */

export const REDACTION = '[GIZLI]';

/**
 * Saglayici anahtar bicimleri (ERE/JS ortak soz dizimi, buyuk/kucuk harf
 * duyarli). `scan-secrets.sh`'taki desenlerin USTKUMESI: ozel anahtar bloku
 * govdesiyle birlikte, ayrica `sk-proj-` (tire iceren OpenAI proje anahtari).
 */
export const SECRET_TOKEN_PATTERNS: readonly string[] = [
  'sk-ant-[A-Za-z0-9_-]{20,}',
  'sk-[A-Za-z0-9]{32,}',
  'sk-proj-[A-Za-z0-9_-]{20,}',
  'gh[opsur]_[A-Za-z0-9]{36,}',
  'github_pat_[A-Za-z0-9_]{60,}',
  'AKIA[0-9A-Z]{16}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'AIza[0-9A-Za-z_-]{35}',
  '[sr]k_live_[A-Za-z0-9]{16,}',
  'npm_[A-Za-z0-9]{36,}',
  'hf_[A-Za-z0-9]{34,}',
  // Govdesiyle birlikte; END satiri yoksa (kesik yapistirma) metnin sonuna kadar.
  '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)',
];

const TOKEN_REGEXES = SECRET_TOKEN_PATTERNS.map((source) => new RegExp(source, 'g'));

/** HTTP basligi buyuk/kucuk harfe duyarsizdir; token desenlerinden ayri tutulur. */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;

/** Baslik baglami sart: duz "Basic infrastructure" cumlesi sir degildir. Baslik kalir, deger gider. */
const BASIC_AUTH = /(\bauthorization\s*[:=]\s*["']?)basic\s+[A-Za-z0-9+/=]{8,}/gi;

/**
 * JWT (`baslik.govde.imza`, taban64url): ilk iki parca JSON nesnesi oldugu icin
 * `eyJ` ile baslar; imza bos olabilir (`alg: none`). Bastaki `(?<!...)` aramayi
 * kosunun basina sabitler: kosunun her ic konumunda yeniden denemek uzun
 * girdilerde ikinci dereceden sure uretirdi.
 */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g;

/** `sema://kullanici:PAROLA@host` (`redis://:PAROLA@host` dahil): yalniz parola gider. */
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/?#@]*:)[^\s/?#]+(?=@)/g;

/**
 * Etiketli deger ("sifre: x", "DB_PASSWORD=x", `"apiKey": "x"`, `clientSecret: x`).
 * Etiket bir tanimlayicinin SONU olabilir (`DB_PASSWORD`, `x-api-key`,
 * `clientSecret`, `PGPASSWORD`); ayrac ve tirnakli JSON anahtari
 * (`password"` + `:`) etiketten sonra gelir. Etiketler iki sinifa ayrilir:
 *
 * - PAROLA sinifi ("sifre: x", "parolam=x", "DB_PASSWORD=x"): deger NE OLURSA
 *   OLSUN sirdir. Tirnaksiz deger SATIR SONUNA kadar gider: "sifre: mavi kus
 *   ucuyor 1923" gibi bosluklu bir parolanin kalan sozcukleri sizmasin.
 *   Tirnakliysa tirnaga kadar alinir.
 * - BELIRSIZ sinif (`anahtar`, `token`, `secret`, `api key`, `_key`): Turkcede
 *   `anahtar` fiziksel anahtardir ("ev anahtari: mavi cekmece"). Her degeri sir
 *   sayip kaydi `secret` yapmak Smith'in onu Live'da HATIRLAMASINI engellerdi;
 *   yalniz deger kimlik bilgisi seklindeyse sirdir (`looksLikeCredential`).
 *
 * `pass`/`pwd` ve Turkce govdeler ("parola", "sifre", "anahtar") kisadir ya da
 * gunluk sozcuklerle cakisir (`bypass`, `compass`): yalniz bagimsiz sozcuk ya da
 * ayracli ek (`DB_PASS`) olarak etiket sayilir. Uzun Ingilizce etiketler
 * (`password`, `secret`, `token`, `api key`) camelCase ve bitisik buyuk harfli
 * adlarda da gecer; `_key` gibi kisa ekler yalniz ayracla birlikte. Turkce ek
 * alan etiketler (`parolam`, `anahtarim`) `\p{L}*` ile yakalanir; ASCII `\b`
 * bastaki `ş` icin sinir gormedigi icin Unicode farkindali kenar kontrolu
 * kullanilir.
 */
const NOT_AFTER_LETTER = String.raw`(?<![\p{L}\p{N}])`;
const PASSWORD_LABEL = String.raw`(?:${NOT_AFTER_LETTER}(?:pass|pwd|parola\p{L}*|[sş][iıİ]fre\p{L}*)|pass(?:word|wd))`;
const AMBIGUOUS_LABEL = String.raw`(?:${NOT_AFTER_LETTER}anahtar\p{L}*|secret(?:[ _-]?(?:access[ _-]?)?key)?|token|api[ _-]?key|[_.-]key)`;
/** Tirnakli deger; `\"` gibi kacislar degeri kesmez (JSON dizgeleri kacis icerir). */
const QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const SINGLE_TOKEN_VALUE = String.raw`(?:${QUOTED}|[^\s,;]+)`;
const REST_OF_LINE_VALUE = String.raw`(?:${QUOTED}|\S[^\r\n]*)`;
/** Gruplar: 1 etiket, 2 kapanis tirnagi (JSON anahtari), 3 ayirac, 4 deger. */
const labeled = (label: string, value: string): RegExp =>
  new RegExp(`(${label})(["']?)(\\s*[:=]\\s*)(${value})`, 'giu');
const PASSWORD_LABELED = labeled(PASSWORD_LABEL, REST_OF_LINE_VALUE);
const AMBIGUOUS_LABELED = labeled(AMBIGUOUS_LABEL, SINGLE_TOKEN_VALUE);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Maskeden sonra "anlamli icerik kaldi mi" olcumunde maskelenmis atamalar
 * (`DB_PASSWORD=[GIZLI]`, `api key: [GIZLI]`) etiket sozcukleriyle birlikte
 * sayilmaz: tek basina bilgi tasimazlar. Arama tanimlayici kosusunun basina
 * sabitlenir; her ic konumdan yeniden denemek uzun girdilerde ikinci dereceden
 * sure uretirdi.
 */
const MASKED_ASSIGNMENT = new RegExp(
  `(?<![\\p{L}\\p{N}_.-])[\\p{L}\\p{N}_.-]*?(?:${PASSWORD_LABEL}|${AMBIGUOUS_LABEL})["']?\\s*[:=]\\s*${escapeRegExp(REDACTION)}`,
  'giu',
);

/**
 * Belirsiz etiketin degeri kimlik bilgisi seklinde mi: TEK PARCA (bosluksuz) ve
 * en az 16 karakter ya da en az 8 karakter + hem harf hem rakam. "mavi" ve
 * "kirmizi kutu" degildir; "abc123def456" ve "9f8e7d6c5b4a3f2e1d0c" kimlik
 * bilgisidir.
 */
function looksLikeCredential(rawValue: string): boolean {
  const value = rawValue.replace(/^(["'])(.*)\1$/u, '$2');
  if (/\s/u.test(value)) return false;
  if (value.length >= 16) return true;
  return value.length >= 8 && /\p{L}/u.test(value) && /\p{Nd}/u.test(value);
}

export interface RedactedText {
  /** Secret parcalari `[GIZLI]` ile degistirilmis metin. */
  readonly text: string;
  readonly found: boolean;
  /** Maskeden sonra anlamli icerik kalmadi: indekslenmemeli / uzaga gonderilmemeli. */
  readonly secretOnly: boolean;
}

export function redactSecrets(input: string): RedactedText {
  let found = false;
  const mask = (): string => {
    found = true;
    return REDACTION;
  };

  let text = input;
  for (const pattern of TOKEN_REGEXES) text = text.replace(pattern, mask);
  text = text.replace(BEARER_TOKEN, mask);
  text = text.replace(BASIC_AUTH, (_match, head: string) => `${head}${mask()}`);
  text = text.replace(JWT, mask);
  text = text.replace(URL_PASSWORD, (_match, head: string) => `${head}${mask()}`);
  text = text.replace(
    PASSWORD_LABELED,
    (_match, label: string, quote: string, separator: string, value: string) =>
      `${label}${quote}${separator}${mask()}${value.slice(value.trimEnd().length)}`,
  );
  text = text.replace(
    AMBIGUOUS_LABELED,
    (match, label: string, quote: string, separator: string, value: string) =>
      looksLikeCredential(value) ? `${label}${quote}${separator}${mask()}` : match,
  );

  return { text, found, secretOnly: found && !hasContentBesidesMasks(text) };
}

/** Maskeler ve maskeli atamalar cikinca harf ya da rakam (anlamli icerik) kaldi mi. */
function hasContentBesidesMasks(maskedText: string): boolean {
  const residual = maskedText.replaceAll(MASKED_ASSIGNMENT, '').replaceAll(REDACTION, '');
  return /[\p{L}\p{N}]/u.test(residual);
}
