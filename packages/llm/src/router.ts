import { DEFAULT_ATTEMPT_TIMEOUT_MS, isRetryableLlmError } from './fallback.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createOpenAiCompatProvider } from './providers/openai-compat.js';
import {
  LlmError,
  type ChatMessage,
  type ChatResult,
  type LlmProvider,
  type LlmRole,
  type ProviderKind,
  type RoleConfig,
  type StreamOptions,
  type ToolChatResult,
  type ToolDefinition,
  type ToolMessage,
} from './types.js';

/**
 * Rol → model yonlendirme (earlier-project deseninden). Roller is turudur; hangi
 * saglayici/modelin kosacagi konfigurasyondur. Ilerideki adim: bu
 * konfigurasyonun workspace basina override edilebilmesi (kiraci kendi
 * anahtarini getirir).
 *
 * YEDEK ZINCIRI: birincil saglayici gecici olarak dusunce (kota/yuk/ag/stall)
 * istek sonraki halkaya duser. Model ADLARI saglayicilar arasi FARKLIDIR, o
 * yuzden her halka kendi model adini tasir.
 */
export interface LlmFallback {
  /** Log/teshis etiketi: 'openrouter', 'ollama'… */
  label: string;
  baseUrl: string;
  apiKey?: string;
  /** Rol → o saglayicidaki model adi. Rol yoksa bu halka o rolde atlanir. */
  models: Partial<Record<LlmRole, string>>;
}

export interface LlmRouterConfig {
  roles: Record<LlmRole, RoleConfig>;
  anthropicApiKey?: string;
  openAiCompatBaseUrl?: string;
  openAiCompatApiKey?: string;
  /** Birincilden sonra SIRAYLA denenecek halkalar. */
  fallbacks?: readonly LlmFallback[];
  /** Tek denemenin ust suresi; stall'i yakalayan sey budur. */
  attemptTimeoutMs?: number;
  /** Yedege gecis gozlemlenebilirligi (gateway bunu loglar). */
  onFallback?: (info: { role: LlmRole; from: string; to: string; reason: string }) => void;
}

export interface LlmRouter {
  streamChat(role: LlmRole, messages: ChatMessage[], options?: StreamOptions): Promise<ChatResult>;
  generateWithTools(
    role: LlmRole,
    messages: readonly ToolMessage[],
    tools: readonly ToolDefinition[],
    options?: StreamOptions,
  ): Promise<ToolChatResult>;
}

interface ChainLink {
  readonly label: string;
  readonly provider: LlmProvider;
  readonly roleConfig: RoleConfig;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 120);
  return String(error).slice(0, 120);
}

export function createLlmRouter(config: LlmRouterConfig): LlmRouter {
  const providers = new Map<ProviderKind, LlmProvider>();
  const attemptTimeoutMs = config.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;

  if (config.anthropicApiKey) {
    providers.set('anthropic', createAnthropicProvider(config.anthropicApiKey));
  }
  if (config.openAiCompatBaseUrl) {
    providers.set(
      'openai-compat',
      createOpenAiCompatProvider({
        baseUrl: config.openAiCompatBaseUrl,
        ...(config.openAiCompatApiKey ? { apiKey: config.openAiCompatApiKey } : {}),
      }),
    );
  }

  // Yedek halkalarin saglayicilari bir kez kurulur (her istekte degil).
  const fallbackProviders = (config.fallbacks ?? []).map((f) => ({
    spec: f,
    provider: createOpenAiCompatProvider({
      baseUrl: f.baseUrl,
      ...(f.apiKey ? { apiKey: f.apiKey } : {}),
    }),
  }));

  function chainFor(role: LlmRole): ChainLink[] {
    const roleConfig = config.roles[role];
    const provider = providers.get(roleConfig.provider);
    if (!provider) {
      const hint: Record<ProviderKind, string> = {
        anthropic: 'ANTHROPIC_API_KEY gerekli.',
        'openai-compat': 'OLLAMA_BASE_URL gerekli.',
      };
      throw new LlmError(
        `'${role}' rolu '${roleConfig.provider}' saglayicisina yonlendirildi ama o saglayici yapilandirilmamis. ${hint[roleConfig.provider]}`,
        roleConfig.provider,
      );
    }

    const links: ChainLink[] = [{ label: 'birincil', provider, roleConfig }];
    for (const { spec, provider: fallbackProvider } of fallbackProviders) {
      const model = spec.models[role];
      if (!model) continue; // bu halka bu rolu servis etmiyor
      links.push({
        label: spec.label,
        provider: fallbackProvider,
        // Model adi halkaya ozgu; kalan ayarlar (token tavani vs.) rolden gelir.
        roleConfig: { ...roleConfig, provider: 'openai-compat', model },
      });
    }
    return links;
  }

  /**
   * Zinciri sirayla dener.
   *
   * TASARIM KARARI — gorunur cikti uretmis bir denemeden sonra YEDEGE DUSULMEZ.
   * Saglayici A birkac token akitip sonra olurse, B'nin tam yaniti kullanicinin
   * ekraninda yarim cevabin PESINE eklenirdi (bozuk transkript). Bu yuzden
   * `onDelta` bir kez cagrildiysa hata aynen yukari birakilir. Bugun sahada
   * gorulen ariza (stall / 429 / 503) zaten ILK token'dan ONCE olusuyor, yani
   * yedek tam da ise yaradigi yerde devrede.
   */
  async function runChain<T>(
    role: LlmRole,
    options: StreamOptions | undefined,
    run: (provider: LlmProvider, roleConfig: RoleConfig, options: StreamOptions) => Promise<T>,
  ): Promise<T> {
    // Cagridan ONCE iptal edilmis sinyal: `abort` olayi bir daha ateslenmeyecegi
    // icin asagidaki dinleyici bunu yakalayamaz; istek hic baslamasin.
    options?.signal?.throwIfAborted();

    const links = options?.singleAttempt ? chainFor(role).slice(0, 1) : chainFor(role);
    const failures: string[] = [];

    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      if (!link) break;

      const controller = new AbortController();
      let timedOut = false;
      let sawDelta = false;
      let attemptActive = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          attemptActive = false;
          controller.abort();
          reject(new LlmError(`LLM yaniti ${attemptTimeoutMs}ms icinde gelmedi.`, 'openai-compat'));
        }, attemptTimeoutMs);
      });
      const userSignal = options?.signal;
      const onUserAbort = (): void => controller.abort();
      userSignal?.addEventListener('abort', onUserAbort, { once: true });

      const attemptOptions: StreamOptions = {
        signal: controller.signal,
        ...(options?.singleAttempt ? { singleAttempt: true } : {}),
        ...(options?.onDelta
          ? {
              onDelta: (text: string) => {
                if (!attemptActive) return;
                sawDelta = true;
                options.onDelta?.(text);
              },
            }
          : {}),
      };

      try {
        /*
         * Zaman asimi BIZIM tarafimizdan dayatilir (Promise.race), yalniz
         * `abort` sinyaliyle degil: saglayici sinyali dinlemezse ya da SDK
         * fetch'ten ONCE asilirsa abort tek basina turu kurtarmaz. Race ile
         * bekleyisi HER durumda birakiriz; `controller.abort()` yine cagrilir
         * ki soket bosa akmasin. Terk edilen deneme sonradan reddederse
         * "unhandled rejection" olmasin diye yutulur.
         */
        const attempt = run(link.provider, link.roleConfig, attemptOptions);
        attempt.catch(() => undefined);
        return await Promise.race([attempt, timeoutPromise]);
      } catch (error) {
        if (userSignal?.aborted) throw error; // kullanici iptali: yedek yok
        const reason = timedOut ? `zaman asimi (${attemptTimeoutMs}ms)` : describe(error);
        failures.push(`${link.label}[${link.roleConfig.model}]: ${reason}`);

        const retryable = timedOut || isRetryableLlmError(error);
        const next = links[i + 1];
        if (!retryable || sawDelta || !next) {
          if (next && retryable && sawDelta) {
            // Yedek VAR ama akan cikti yuzunden kullanilamadi; sebebi gorunur olsun.
            throw new LlmError(
              `LLM akis ortasinda dustu, yedege gecilmedi (yarim cevap bozulmasin): ${failures.join(' | ')}`,
              link.roleConfig.provider,
              { cause: error },
            );
          }
          if (!next && retryable) {
            throw new LlmError(
              `Tum LLM saglayicilari basarisiz: ${failures.join(' | ')}`,
              link.roleConfig.provider,
              { cause: error },
            );
          }
          throw error; // kalici ariza (400/401/403…): fail-loud
        }

        config.onFallback?.({ role, from: link.label, to: next.label, reason });
      } finally {
        attemptActive = false;
        clearTimeout(timer);
        userSignal?.removeEventListener('abort', onUserAbort);
      }
    }

    throw new LlmError(`'${role}' rolu icin calisan saglayici yok.`, 'openai-compat');
  }

  return {
    async streamChat(role, messages, options) {
      return runChain(role, options, (provider, roleConfig, attemptOptions) =>
        provider.streamChat(roleConfig, messages, attemptOptions),
      );
    },
    async generateWithTools(role, messages, tools, options) {
      return runChain(role, options, (provider, roleConfig, attemptOptions) =>
        provider.generateWithTools(roleConfig, messages, tools, attemptOptions),
      );
    },
  };
}
