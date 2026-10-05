import { z } from 'zod';

/**
 * Ortam yapilandirmasi tek noktadan, sema ile dogrulanir ve fail-fast davranir.
 *
 * Tasarim karari: eksik veya bozuk config'i uygulama ilk istekte degil,
 * acilista fark eder. Yarim ayakta kalan bir servis, hic kalkmayan bir
 * servisten daha pahalidir.
 */

const nonEmpty = z.string().trim().min(1);

/**
 * Ortam degiskeninde BOS deger "verilmedi" demektir, "bos verildi" degil.
 * `.env.example` kopyalanip opsiyonel alanlar bos birakildiginda sema
 * patlamamalidir; `FOO=` ile `FOO`'nun hic olmamasi ayni anlama gelir.
 */
const emptyAsUndefined = (raw: unknown): unknown =>
  typeof raw === 'string' && raw.trim() === '' ? undefined : raw;

/** Bos degeri yok sayan opsiyonel alan. */
function optionalEnv<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return z.preprocess(emptyAsUndefined, schema.optional());
}

/** Bos degeri yok sayan, varsayilani olan alan. */
function defaultedEnv<TSchema extends z.ZodTypeAny>(schema: TSchema, fallback: TSchema['_output']) {
  return z.preprocess(emptyAsUndefined, schema.default(fallback));
}

/** Bayrak alani: '1'/'true'/'on' => true; bos veya baska her sey => false. */
function flagEnv() {
  return z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .optional()
      .transform((v) => v === '1' || v === 'true' || v === 'on'),
  );
}

/** Log ve hata ciktilarinda deger sizmasin diye maskelenecek anahtarlar. */
const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|KEY|DSN|CREDENTIAL|URL)$/i;

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export type NodeEnvName = z.infer<typeof nodeEnvSchema>;

/** Her Smith surecinin paylastigi taban. */
export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** Virgulle ayrilmis sourceId globlari ve `kw:` icerik anahtar kelimeleri. */
  SMITH_CONTEXT_EXCLUDE: z.string().default(''),
});

export const databaseEnvSchema = z.object({
  /** pgvector eklentili Postgres. Hafiza ve embedding katmani buna baglidir. */
  DATABASE_URL: nonEmpty.url(),
});

export const redisEnvSchema = z.object({
  REDIS_URL: nonEmpty.url(),
});

/**
 * Yapilandirma verilmemis bir kurulumda kullanilan YEREL sohbet modeli.
 * Disari veri cikmayan varsayilan budur; uzak bir uca bu ad gonderilemez.
 */
export const LOCAL_DEFAULT_MODEL = 'gemma3:1b';

/** Gomme ucu verilmeyen kurulumda yerel Ollama'nin taniyip DB boyutuna (768) uyan modeli. */
export const LOCAL_DEFAULT_EMBED_MODEL = 'nomic-embed-text';

export const modelEnvSchema = z.object({
  ANTHROPIC_API_KEY: optionalEnv(nonEmpty),
  /** Yerel model yolu; token maliyeti sifir olan tarafi buradan gecer. */
  OLLAMA_BASE_URL: defaultedEnv(nonEmpty.url(), 'http://127.0.0.1:11434'),
  /**
   * Sohbetin gittigi OpenAI-uyumlu uc. Verilmezse yerel Ollama kullanilir ve
   * hicbir veri makineden cikmaz. EMBEDDING bundan BAGIMSIZDIR ve KENDI ucunu
   * kullanir (SMITH_EMBED_*); varsayilan yerel ama uzak uc verilirse hafiza
   * icerigi o uca gider — otomatik yerel GARANTISI yoktur.
   */
  SMITH_LLM_BASE_URL: optionalEnv(nonEmpty.url()),
  SMITH_LLM_API_KEY: optionalEnv(nonEmpty),
  /** Sohbet modeli. Varsayilan yerel kalir; uzak uc secilirse acikca verilir. */
  SMITH_LLM_MODEL: defaultedEnv(nonEmpty, LOCAL_DEFAULT_MODEL),
  /**
   * YEDEK SAGLAYICI (zincirin 2. halkasi; OpenAI-uyumlu herhangi bir uc).
   * Birincil gecici olarak dusunce (429 kota / 503 yuk / stall) istek buraya
   * duser. Model ADI saglayiciya ozgudur — bir saglayicinin model adi digerinde
   * gecmez, o yuzden ayri alan. Uc verilirse ANAHTAR ve MODEL de zorunludur
   * (bkz. checkModelConfig).
   */
  SMITH_LLM_FALLBACK_BASE_URL: optionalEnv(nonEmpty.url()),
  SMITH_LLM_FALLBACK_API_KEY: optionalEnv(nonEmpty),
  SMITH_LLM_FALLBACK_MODEL: optionalEnv(nonEmpty),
  /**
   * Zincirin SON halkasi olarak yerel Ollama eklensin mi (varsayilan KAPALI).
   * Kapali cunku yerel kucuk model tool-calling'i guvenilir yapamaz: acikken
   * bulut dustugunde asistan "calisiyor" gorunup sessizce yanlis is yapar.
   * Yalniz duz sohbetin ayakta kalmasi istendiginde acilir.
   */
  SMITH_LLM_LOCAL_FALLBACK: flagEnv(),
  /** Yerel halkanin model adi (yalniz SMITH_LLM_LOCAL_FALLBACK acikken kullanilir). */
  SMITH_LLM_LOCAL_MODEL: defaultedEnv(nonEmpty, LOCAL_DEFAULT_MODEL),
  /**
   * Tek denemenin ust suresi (ms). STALL'i yakalayan sey budur: 2026-08-25'te
   * Gemini yanit vermeden asili kaldi ve istemci 120 sn bekledi. Sure dolunca
   * deneme iptal edilir ve zincirin sonraki halkasi denenir.
   */
  SMITH_LLM_TIMEOUT_MS: optionalEnv(z.coerce.number().int().positive()),
  /**
   * EMBEDDING ucu. Gateway VE worker ayni degerleri okur (createEmbedderFromEnv)
   * — ikisi elle ayri yazildigi icin sapmisti (worker OLLAMA'ya sabitti). Uc
   * verilmezse yerel Ollama/nomic; verilirse o uc. Boyut daima 768 (DB vector).
   * Capraz kurallar `checkModelConfig`'te: uzak uc anahtar ister, uc verilmeyip
   * model yerel varsayilandan farkliysa acilista durur.
   */
  SMITH_EMBED_BASE_URL: optionalEnv(nonEmpty.url()),
  SMITH_EMBED_API_KEY: optionalEnv(nonEmpty),
  SMITH_EMBED_MODEL: defaultedEnv(nonEmpty, LOCAL_DEFAULT_EMBED_MODEL),
  /**
   * DB kolonu `vector(768)` ve `@smith/memory` EMBEDDING_DIMENSIONS ile AYNI
   * sabit. Baska bir deger acilista reddedilir; aksi halde embedder vektoru
   * hemen "768 bekleniyordu" hatasiyla reddeder ve tum hafiza isleri
   * calisma aninda duserdi.
   */
  SMITH_EMBED_DIMENSIONS: optionalEnv(z.coerce.number().pipe(z.literal(768))),
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** Uc makinede mi duruyor? Cozumlenemeyen URL uzak sayilir (guvenli taraf). */
function isLocalEndpoint(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.local');
  } catch {
    return false;
  }
}

/**
 * Model yapilandirmasinin CAPRAZ kurallari.
 *
 * Tek tek gecerli olan degerler birlikte gecersiz olabilir ve bu arizalar
 * calisma zamaninda "Smith aptallasti ama hata yok" diye gorunur:
 *   - Uzak uc secilip anahtar verilmemesi (dev-secrets.local.ps1 kosmadiysa).
 *   - Uzak uc secilip model adinin yerel varsayilanda kalmasi — istek
 *     `gemma3:1b` diye bir modeli olmayan bir saglayiciya gider.
 *   - Gomme ucunda ayni iki ariza ters yonde: uzak uc anahtarsiz ya da uc
 *     verilmeyip (yerel Ollama) modelin uzak bir ad olmasi.
 * Hepsi acilista yakalanir; yarim ayakta kalan servis hic kalkmayandan
 * pahalidir (dosyanin en ustundeki tasarim karari).
 */
export function checkModelConfig(
  value: z.infer<typeof modelEnvSchema>,
  ctx: z.RefinementCtx,
): void {
  // GOMME UCU: gateway ve worker AYNI ucu okur (createEmbedderFromEnv). Sapma
  // calisma aninda ortaya cikardi: her gomme cagrisi duser, hafiza isleri 3
  // denemeden sonra sessizce kaybolur. Yerel uc anahtar istemez.
  const embedUrl = value.SMITH_EMBED_BASE_URL;
  if (!embedUrl) {
    if (value.SMITH_EMBED_MODEL !== LOCAL_DEFAULT_EMBED_MODEL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMITH_EMBED_MODEL'],
        message:
          `gomme ucu verilmedi (yerel Ollama) ama model (${value.SMITH_EMBED_MODEL}) ` +
          `yerel varsayilanda (${LOCAL_DEFAULT_EMBED_MODEL}) degil; uzak saglayicinin ` +
          "model adi yerel Ollama'da yok. SMITH_EMBED_BASE_URL'yi ver ya da modeli " +
          `${LOCAL_DEFAULT_EMBED_MODEL} yap`,
      });
    }
  } else if (!isLocalEndpoint(embedUrl) && !value.SMITH_EMBED_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMITH_EMBED_API_KEY'],
      message:
        `uzak gomme ucu secildi (${embedUrl}) ama anahtar verilmedi; ` +
        'anahtarsiz istek yetkisiz doner',
    });
  }

  // YEDEK HALKA: yarim yapilandirma en kotu anda (birincil dustugunde) ortaya
  // cikardi — acilista yakala. Uc verildiyse anahtar ve model de zorunlu.
  const fallbackUrl = value.SMITH_LLM_FALLBACK_BASE_URL;
  if (fallbackUrl && !isLocalEndpoint(fallbackUrl)) {
    if (!value.SMITH_LLM_FALLBACK_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMITH_LLM_FALLBACK_API_KEY'],
        message:
          `yedek LLM ucu secildi (${fallbackUrl}) ama anahtar verilmedi; ` +
          'birincil dustugunde yedek de yetkisiz doner',
      });
    }
    if (!value.SMITH_LLM_FALLBACK_MODEL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMITH_LLM_FALLBACK_MODEL'],
        message:
          `yedek LLM ucu secildi (${fallbackUrl}) ama model adi verilmedi; ` +
          'model adlari saglayicilar arasi farklidir (birincilinki gecerli degil)',
      });
    }
  }

  const baseUrl = value.SMITH_LLM_BASE_URL;
  if (!baseUrl || isLocalEndpoint(baseUrl)) return;

  if (!value.SMITH_LLM_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMITH_LLM_API_KEY'],
      message:
        `uzak LLM ucu secildi (${baseUrl}) ama anahtar verilmedi; ` +
        'anahtarsiz istek yetkisiz doner',
    });
  }

  if (value.SMITH_LLM_MODEL === LOCAL_DEFAULT_MODEL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMITH_LLM_MODEL'],
      message:
        `uzak LLM ucu secildi (${baseUrl}) ama model yerel varsayilanda ` +
        `(${LOCAL_DEFAULT_MODEL}); uzak saglayicida bu ad yok`,
    });
  }
}

export const observabilityEnvSchema = z.object({
  LANGFUSE_BASE_URL: optionalEnv(nonEmpty.url()),
  LANGFUSE_PUBLIC_KEY: optionalEnv(nonEmpty),
  LANGFUSE_SECRET_KEY: optionalEnv(nonEmpty),
});

export const memoryMaintenanceEnvSchema = z.object({
  SMITH_MEMORY_MAINTENANCE: defaultedEnv(z.enum(['0', '1']), '1'),
  SMITH_MEMORY_MAINTENANCE_INTERVAL_MS: optionalEnv(z.coerce.number().int().min(60_000)),
  SMITH_MEMORY_MAINTENANCE_TIMEZONE: defaultedEnv(
    nonEmpty.refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, 'gecersiz saat dilimi'),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ),
  SMITH_MEMORY_MAINTENANCE_SIMILARITY: defaultedEnv(z.coerce.number().min(0.5).max(1), 0.92),
  SMITH_MEMORY_MAINTENANCE_MAX_CLUSTERS: defaultedEnv(z.coerce.number().int().min(1).max(50), 10),
  SMITH_MEMORY_MAINTENANCE_MAX_GAPS: defaultedEnv(z.coerce.number().int().min(1).max(20), 10),
});
export type MemoryMaintenanceEnv = z.infer<typeof memoryMaintenanceEnvSchema>;

/** Gateway sureci: istemcilerin bagladigi tek kapi. */
export const gatewayEnvSchema = baseEnvSchema
  .merge(memoryMaintenanceEnvSchema)
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(modelEnvSchema)
  .merge(observabilityEnvSchema)
  .extend({
    PORT: z.coerce.number().int().positive().max(65535).default(4100),
    /**
     * Dinleme adresi. Varsayilan loopback: gateway yalniz bu makineden erisilir.
     * Eskiden hostname verilmiyordu ve Node tum arayuzlerde dinliyordu. Konteyner
     * ici dinleme (compose/Docker) disaridan erisilebilmek icin `0.0.0.0`'i
     * ACIKCA verir; yerel gelistirme hicbir sey vermez.
     */
    SMITH_GATEWAY_HOST: defaultedEnv(nonEmpty, '127.0.0.1'),
    /** Oturum imzalama sirri. Uretimde 32 karakterden kisa olamaz. */
    SESSION_SECRET: nonEmpty.min(32),
    /** Virgulle ayrilmis izinli origin listesi. */
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    /**
     * Faz 2b: sohbet turunu `packages/core` tool-loop'una gecirir (model
     * hafiza araclarini cagirabilir). Varsayilan KAPALI → mevcut streaming
     * `runChatTurn` yolu calisir.
     */
    SMITH_AGENT_LOOP: flagEnv(),
  })
  .superRefine(checkModelConfig);

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

/** Worker sureci: gateway'in HTTP yuzeyine ihtiyaci yoktur. */
export const workerEnvSchema = baseEnvSchema
  .merge(memoryMaintenanceEnvSchema)
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(modelEnvSchema)
  .merge(observabilityEnvSchema)
  .superRefine(checkModelConfig);

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

function maskValue(key: string, value: string | undefined): string {
  if (value === undefined) return '(tanimsiz)';
  if (!SECRET_KEY_PATTERN.test(key)) return value;
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}***${value.slice(-2)} (${value.length} karakter)`;
}

/**
 * Semayi uygular; basarisizsa maskelenmis, okunabilir bir rapor ile patlar.
 * Secret degerleri hata ciktisinda asla ham gorunmez.
 */
export function loadEnv<TOutput>(
  schema: z.ZodType<TOutput, z.ZodTypeDef, unknown>,
  source: Record<string, string | undefined> = process.env,
): TOutput {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join('.') || '(kok)';
    return `${key}: ${issue.message} — gelen deger: ${maskValue(key, source[key])}`;
  });

  throw new EnvValidationError(
    `Ortam yapilandirmasi gecersiz (${issues.length} sorun). Surec baslatilmadi.`,
    issues,
  );
}
