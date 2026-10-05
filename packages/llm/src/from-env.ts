import { createLlmRouter, type LlmFallback, type LlmRouter } from './router.js';

/**
 * Env'den router (+ yedek zinciri) cozer.
 *
 * TEK NOKTA — gateway ve worker AYNI zinciri kullansin diye. Bu ders pahaliya
 * ogrenildi: embedder iki yerde elle kurulmustu ve sessizce sapmisti (worker
 * OLLAMA'ya sabit kalip gateway'in ayarini yok sayiyordu, bkz.
 * `createEmbedderFromEnv`). Zincirde ayni sapma "yedek yalniz gateway'de var"
 * demek olurdu — worker gece yarisi kotaya takilip sessizce olurdu.
 *
 * `cfg` YAPISALDIR; `@smith/env`'e baglanmaz (paket bagimliligi ters yone
 * gitmesin).
 */
export interface LlmEnvConfig {
  ANTHROPIC_API_KEY?: string | undefined;
  OLLAMA_BASE_URL: string;
  SMITH_LLM_BASE_URL?: string | undefined;
  SMITH_LLM_API_KEY?: string | undefined;
  SMITH_LLM_MODEL: string;
  SMITH_LLM_FALLBACK_BASE_URL?: string | undefined;
  SMITH_LLM_FALLBACK_API_KEY?: string | undefined;
  SMITH_LLM_FALLBACK_MODEL?: string | undefined;
  SMITH_LLM_LOCAL_FALLBACK?: boolean | undefined;
  SMITH_LLM_LOCAL_MODEL?: string | undefined;
  SMITH_LLM_TIMEOUT_MS?: number | undefined;
}

/** Yapilandirilmis yedek halkalari SIRAYLA uretir (once uzak, sonra yerel). */
export function buildFallbacks(cfg: LlmEnvConfig): LlmFallback[] {
  const fallbacks: LlmFallback[] = [];

  // 2. halka: uzak yedek saglayici (OpenAI-uyumlu uc). Model adi ZORUNLU — sema
  // (checkModelConfig) uc verilip model verilmemesini acilista reddeder.
  if (cfg.SMITH_LLM_FALLBACK_BASE_URL && cfg.SMITH_LLM_FALLBACK_MODEL) {
    const model = cfg.SMITH_LLM_FALLBACK_MODEL;
    fallbacks.push({
      label: 'yedek',
      baseUrl: cfg.SMITH_LLM_FALLBACK_BASE_URL,
      ...(cfg.SMITH_LLM_FALLBACK_API_KEY ? { apiKey: cfg.SMITH_LLM_FALLBACK_API_KEY } : {}),
      models: { chat: model, summarizer: model },
    });
  }

  // Son halka: yerel Ollama. Varsayilan KAPALI — kucuk yerel model tool-calling'i
  // guvenilir yapamaz; acikken bulut dustugunde asistan "calisiyor" gorunup
  // sessizce yanlis is yapardi.
  if (cfg.SMITH_LLM_LOCAL_FALLBACK) {
    const model = cfg.SMITH_LLM_LOCAL_MODEL;
    if (model) {
      fallbacks.push({
        label: 'yerel',
        baseUrl: `${cfg.OLLAMA_BASE_URL}/v1`,
        models: { chat: model, summarizer: model },
      });
    }
  }

  return fallbacks;
}

export function createLlmRouterFromEnv(
  cfg: LlmEnvConfig,
  options: {
    onFallback?: (info: { role: string; from: string; to: string; reason: string }) => void;
  } = {},
): LlmRouter {
  const baseUrl = cfg.SMITH_LLM_BASE_URL ?? `${cfg.OLLAMA_BASE_URL}/v1`;
  const model = cfg.SMITH_LLM_MODEL;

  return createLlmRouter({
    roles: {
      chat: {
        provider: cfg.ANTHROPIC_API_KEY ? 'anthropic' : 'openai-compat',
        model: cfg.ANTHROPIC_API_KEY ? 'claude-sonnet-5' : model,
        maxOutputTokens: 1024,
      },
      // Dusunen model (gemini-flash-latest) dusunme belirteclerini cikti
      // butcesinden harcar: 26 turluk oturumda dusunme ~1000 + gorunen ozet ~140
      // belirtec (olcum 2026-10-03). 512'de metin bos kalip is her denemede
      // dusuyordu; 4096 uzun oturumlara pay birakir ve olculen ~190 belirtec/sn
      // ile en kotu tek deneme ~22 sn surer (router tek deneme tavani 45 sn).
      summarizer: { provider: 'openai-compat', model, maxOutputTokens: 4096 },
    },
    ...(cfg.ANTHROPIC_API_KEY ? { anthropicApiKey: cfg.ANTHROPIC_API_KEY } : {}),
    openAiCompatBaseUrl: baseUrl,
    ...(cfg.SMITH_LLM_API_KEY ? { openAiCompatApiKey: cfg.SMITH_LLM_API_KEY } : {}),
    fallbacks: buildFallbacks(cfg),
    ...(cfg.SMITH_LLM_TIMEOUT_MS ? { attemptTimeoutMs: cfg.SMITH_LLM_TIMEOUT_MS } : {}),
    ...(options.onFallback ? { onFallback: options.onFallback } : {}),
  });
}

/** Insan-okunur zincir ozeti (acilista loglanir): "gemini-flash-latest → yedek(uzak…)". */
export function describeChain(cfg: LlmEnvConfig): string {
  const parts = [cfg.SMITH_LLM_MODEL];
  for (const f of buildFallbacks(cfg)) {
    parts.push(`${f.label}(${f.models.chat ?? '?'})`);
  }
  return parts.join(' -> ');
}
