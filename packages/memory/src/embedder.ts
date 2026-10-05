import OpenAI from 'openai';

/**
 * Embedding ureteci. OpenAI-uyumlu endpoint (Ollama /v1) uzerinden calisir;
 * bu, embed endpoint'inin ILK kullanimi oldugu icin @smith/memory'de duruyor.
 * Ikinci bir tuketici cikarsa @smith/llm'e terfi ettirilir (ikinci-kullanim
 * kurali).
 *
 * Boyut sabittir: nomic-embed-text = 768. Model degisirse migration'daki
 * vector(768) ve bu sabit BIRLIKTE degisir — uyusmazlik sessiz bozulma yapar.
 */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * Tek embedding istegi icin zaman asimi (yeniden deneme 1). OpenAI SDK
 * varsayilani 10 dk x 3 deneme: uc baglantiyi kabul edip yanit vermezse sohbet
 * turunun hafiza aramasi (LLM cagrisindan ONCE) ve worker kuyrugu 30 dakikaya
 * kadar kilitleniyordu. SDK zaman asimi yalniz yanit BASLIGINA kadardir; govde
 * okumayi da sinirlamak icin cagiranlar `AbortSignal.timeout(EMBED_TIMEOUT_MS)`
 * gecer (asagidaki `signal`).
 */
export const EMBED_TIMEOUT_MS = 30_000;

/**
 * `signal`: iptal edilen turun (arac zaman asimi, kullanici iptali) uzak
 * embedding istegini de durdurmasi icin istemciye kadar tasinir.
 */
export interface EmbedOptions {
  signal?: AbortSignal | undefined;
  singleAttempt?: boolean;
}

export interface Embedder {
  readonly model: string;
  embed(text: string, options?: EmbedOptions): Promise<number[]>;
  embedBatch(texts: string[], options?: EmbedOptions): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbeddingError';
  }
}

export function createEmbedder(input: {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /**
   * Istenen cikti boyutu. Gemini `gemini-embedding-001` varsayilan 3072 uretir;
   * DB kolonu vector(768) oldugu icin `dimensions: 768` ile Matryoshka
   * kirpmasi istenir. Ollama/nomic bu parametreyi kabul etmez → yalniz
   * verildiğinde gonderilir (yoksa eski davranis korunur).
   */
  dimensions?: number;
}): Embedder {
  const client = new OpenAI({
    baseURL: input.baseUrl,
    apiKey: input.apiKey ?? 'not-required',
    timeout: EMBED_TIMEOUT_MS,
    maxRetries: 1,
  });
  const model = input.model ?? 'nomic-embed-text';
  const dimensions = input.dimensions;

  async function embedBatch(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      const res = await client.embeddings.create(
        {
          model,
          input: texts,
          ...(dimensions ? { dimensions } : {}),
        },
        options.signal || options.singleAttempt
          ? {
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.singleAttempt ? { maxRetries: 0 } : {}),
            }
          : undefined,
      );
      // Gemini OpenAI-uyumlu uc `dimensions`'i SDK yolunda YOK SAYIP tam boyut
      // (3072) donduruyor (curl'de calisiyordu, SDK'da degil). gemini-embedding
      // Matryoshka (MRL) egitimli oldugu icin ilk N boyuta KIRPIP L2 yeniden
      // normalize etmek resmi destekli — kirpma sonrasi normalize sart, yoksa
      // cosine mesafesi bozulur. Hedef boyut yoksa gelen aynen kullanilir.
      const target = dimensions ?? EMBEDDING_DIMENSIONS;
      const vectors = res.data.map((d) => fitDimension(d.embedding, target));
      for (const v of vectors) {
        if (v.length !== EMBEDDING_DIMENSIONS) {
          throw new EmbeddingError(
            `Beklenen ${EMBEDDING_DIMENSIONS} boyut, gelen ${v.length}. Model/schema uyusmazligi.`,
          );
        }
      }
      return vectors;
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError(`Embedding uretilemedi (${input.baseUrl}, ${model}).`, {
        cause: error,
      });
    }
  }

  return {
    model,
    embedBatch,
    async embed(text: string, options = {}): Promise<number[]> {
      const [vector] = await embedBatch([text], options);
      if (!vector) throw new EmbeddingError('Embedding sonucu bos dondu.');
      return vector;
    },
  };
}

/**
 * Env'den embedder cozer. Gateway ve worker AYNI yapilandirmayi kullansin diye
 * TEK nokta: elle-senkron iki cagri drift uretmisti (worker OLLAMA/nomic'e sabit
 * kalip gateway'in SMITH_EMBED_* Gemini ayarini yok sayiyordu; Ollama acilip
 * worker yazsaydi kayitlar sessizce farkli uzayda olurdu). `cfg` yapisaldir,
 * `@smith/env`'e baglanmaz.
 */
export function createEmbedderFromEnv(cfg: {
  SMITH_EMBED_BASE_URL?: string | undefined;
  SMITH_EMBED_API_KEY?: string | undefined;
  SMITH_EMBED_MODEL: string;
  SMITH_EMBED_DIMENSIONS?: number | undefined;
  OLLAMA_BASE_URL: string;
}): Embedder {
  return createEmbedder({
    baseUrl: cfg.SMITH_EMBED_BASE_URL ?? `${cfg.OLLAMA_BASE_URL}/v1`,
    ...(cfg.SMITH_EMBED_API_KEY ? { apiKey: cfg.SMITH_EMBED_API_KEY } : {}),
    model: cfg.SMITH_EMBED_MODEL,
    ...(cfg.SMITH_EMBED_DIMENSIONS ? { dimensions: cfg.SMITH_EMBED_DIMENSIONS } : {}),
  });
}

/**
 * Vektoru hedef boyuta getirir: uzunsa ilk N'e kirpip L2 normalize eder
 * (Matryoshka), kisaysa hata. Kirpma sonrasi normalize kritik — cosine
 * benzerligi birim vektor varsayar; ham kirpma normu bozar.
 */
function fitDimension(v: number[], target: number): number[] {
  if (v.length === target) return v;
  if (v.length < target) return v; // yukselmeyi cagiran taraf yakalar (boyut kontrolu)
  const sliced = v.slice(0, target);
  let norm = 0;
  for (const x of sliced) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return sliced;
  return sliced.map((x) => x / norm);
}

/** pgvector literal formati: [0.1,0.2,...]. $queryRaw'a string olarak gecer. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
