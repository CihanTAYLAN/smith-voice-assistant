/**
 * Ajan dongusunun saglayici-notr tip sozlesmesi.
 *
 * Buradaki tipler bilincli olarak protokol wire sozlesmesini (`@smith/protocol`)
 * aynalar: `ToolCall` alanlari `tool_call` frame'i, `ToolResult` alanlari
 * `tool_result` frame'i ile birebir. Boylece gateway baglamasi (Faz 2b)
 * ceviri gerektirmez.
 *
 * ADR 0008 invariant'i burada YAPISAL olarak korunur: `LoopMessage`
 * yalniz dort bicim tasir ve hicbirinde saglayiciya-opak muhakeme blogu
 * (`thinking` / `redacted_thinking` / `reasoning_content`) yoktur. Gecmis
 * boylece replay ile cozulebilecek ciphertext tasimaz.
 */

import type { ZodTypeAny } from 'zod';
import type { Scope } from '@smith/tenancy';

/** Modelin cagirmak istedigi arac. `tool_call` frame'i ile ayni alanlar. */
export interface ToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
}

/** Bir arac cagrisinin sonucu. `tool_result` frame'i ile ayni alanlar. */
export interface ToolResult {
  readonly toolCallId: string;
  readonly ok: boolean;
  readonly result: unknown;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Dongunun tuttugu saglayici-notr mesaj. Kasten yalniz bu dort bicim vardir;
 * opak muhakeme blogu tasinmaz (ADR 0008).
 */
export type LoopMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly ok: boolean;
      readonly result: unknown;
    };

/** Modelin bir cagri sonunda bildirdigi durak (arac yurutmeden once). */
export type ModelStopReason = 'end_turn' | 'max_tokens' | 'tool_use';

/**
 * Modele gonderilen saglayici-notr arac tanimi. Zod semasi tasinir; saglayiciya
 * ozgu JSON Schema donusumu adapter'in isidir (Faz 2b), core'un degil.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodTypeAny;
}

export interface LoopModelRequest {
  readonly messages: readonly LoopMessage[];
  readonly tools: readonly ToolSpec[];
  readonly signal?: AbortSignal;
  readonly onDelta?: (text: string) => void;
}

export interface LoopModelResult {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stop: ModelStopReason;
  /** Saglayici bildirmediyse undefined — asla uydurulmaz (ADR 0008 ile ayni disiplin). */
  readonly usage?: TokenUsage;
}

/**
 * Model dikisi. Core hicbir saglayiciya baglanmaz; `@smith/llm` bunu adapte eder
 * (Faz 2b). Testler mock bir uygulama enjekte eder.
 */
export interface LoopModel {
  generate(request: LoopModelRequest): Promise<LoopModelResult>;
}

/** Bir arac calisirken tasidigi baglam. Scope zorunludur (AGENTS.md §2). */
export interface ToolRunContext {
  readonly scope: Scope;
  readonly signal?: AbortSignal;
}
