/**
 * Saglayici-bagimsiz sohbet sozlesmesi. onceki projenin rol-tabanli yonlendirme
 * deseninden uyarlandi; fark: coklu provider ve streaming-oncelikli API.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  /** Saglayici bildirmediyse undefined — asla uydurulmaz. */
  usage?: ChatUsage;
}

export interface StreamCallbacks {
  onDelta?(text: string): void;
}

export interface StreamOptions extends StreamCallbacks {
  signal?: AbortSignal;
  /** Bakim kotasi: SDK retry ve yedek saglayici denemelerini kapatir. */
  singleAttempt?: boolean;
}

/** Sistemdeki is turleri. Her rol farkli model/ayar alabilir. */
export const LLM_ROLES = ['chat', 'summarizer'] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

export type ProviderKind = 'anthropic' | 'openai-compat';

export interface RoleConfig {
  provider: ProviderKind;
  model: string;
  maxOutputTokens: number;
  temperature?: number;
}

/**
 * Tool-calling sozlesmesi (ADR 0008 uzlasmasi): `tool_use` / `tool_result`
 * SEFFAF, Smith-uretimi yapisal veridir — saglayiciya-opak muhakeme (`thinking`
 * / `reasoning`) DEGILDIR. Bu yuzden burada tasinabilir; opaque bloklar hala
 * dusurulur. `streamChat` / `ChatResult` yolu degismez.
 */

/** Modele gonderilen arac tanimi. `parameters` saglayici-notr JSON Schema. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** Modelin dondurdugu arac cagrisi (seffaf). */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Ham JSON arguman string'i; cagiran parse eder. */
  readonly arguments: string;
  /**
   * Saglayiciya-ozel OPAK devamlilik verisi (Gemini `thought_signature`; yanitin
   * `tool_calls[].extra_content` alaninda gelir). Ayni saglayiciya round-2'de
   * AYNEN geri verilir — Gemini bu olmadan cok-turlu tool cagrisini 400 ile
   * reddeder ("Function call is missing a thought_signature").
   *
   * ADR 0008 ile uyumu: bu bir muhakeme METNI degil, tool-calling'in devami icin
   * zorunlu provider plumbing'i. `@smith/llm` icinde TUR-ICI tutulur: core'a
   * (`LoopMessage`) girmez, DB'ye yazilmaz, saglayicilar arasi tasinmaz. Yani
   * opaque-blocks invariant'inin korudugu "replay edilebilir ciphertext'i
   * kaliciliastirma" tehdidi burada yok.
   */
  readonly providerMeta?: unknown;
}

/** Tool-loop gecmis mesaji. `thinking`/`reasoning` ASLA tasinmaz. */
export type ToolMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export type ToolStopReason = 'end_turn' | 'max_tokens' | 'tool_use';

export interface ToolChatResult {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stop: ToolStopReason;
  readonly usage?: ChatUsage;
}

export interface LlmProvider {
  readonly kind: ProviderKind;
  streamChat(
    config: RoleConfig,
    messages: ChatMessage[],
    options?: StreamOptions,
  ): Promise<ChatResult>;
  /** Tool-calling turu: model text ve/veya arac cagrisi dondurur. */
  generateWithTools(
    config: RoleConfig,
    messages: readonly ToolMessage[],
    tools: readonly ToolDefinition[],
    options?: StreamOptions,
  ): Promise<ToolChatResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}
