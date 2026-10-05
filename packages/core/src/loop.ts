/**
 * Ajan tool-loop'u: turn/step.
 *
 * dsh'nin `ReactLoopAgent` deseninden uyarlandi (ADR 0010). Bir tur, sifir veya
 * daha cok adimdan olusur; bir adim = bir model cagrisi + o cagrinin istedigi
 * araclar. Model arac istemezse tur biter; isterse araclar calisir ve sonuclar
 * modele geri beslenir. Sabit adim tavani (`maxSteps`) yalnizca kacak korumasidir.
 */

import type { Scope } from '@smith/tenancy';
import { evaluateGuards, type ToolGuard } from './guard.js';
import type { ToolRegistry } from './tool.js';
import type {
  LoopMessage,
  LoopModel,
  LoopModelRequest,
  LoopModelResult,
  TokenUsage,
  ToolCall,
  ToolResult,
} from './types.js';

export type TurnStopReason = 'end_turn' | 'max_tokens' | 'cancelled' | 'error' | 'max_steps';

/** Protokol `done.stopReason` yalnizca dort deger tanir. */
export type WireStopReason = 'end_turn' | 'max_tokens' | 'cancelled' | 'error';

/**
 * Core durak sebebini protokol degerine indirger. `max_steps` bir guvenlik
 * tavanidir ve tur TAMAMLANMAMISTIR (model arac sonucunu isleyip cevap
 * veremedi); protokolde basari ('end_turn') gibi sunulmaz, 'error' olur.
 */
export function toWireStopReason(reason: TurnStopReason): WireStopReason {
  return reason === 'max_steps' ? 'error' : reason;
}

/**
 * Device-locus araclar icin kopru. Gateway bunu saglar: `tool_call` frame'i
 * yollar ve istemciden `tool_result` frame'i gelene kadar bekler.
 */
export type DeviceToolBridge = (
  call: ToolCall,
  ctx: { scope: Scope; signal?: AbortSignal },
) => Promise<ToolResult>;

export interface RunAgentTurnOptions {
  readonly model: LoopModel;
  readonly registry: ToolRegistry;
  readonly scope: Scope;
  readonly messages: readonly LoopMessage[];
  readonly guards?: readonly ToolGuard[];
  readonly deviceBridge?: DeviceToolBridge;
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
  readonly toolTimeoutMs?: number;
  readonly onDelta?: (text: string) => void;
}

export interface AgentTurnResult {
  readonly stopReason: TurnStopReason;
  /** Son asistan turunun metni. */
  readonly text: string;
  /** Loop sonundaki tam, saglayici-notr gecmis. */
  readonly messages: readonly LoopMessage[];
  readonly usage: TokenUsage;
  /** stopReason === 'error' ise sebep. */
  readonly error?: unknown;
}

const DEFAULT_MAX_STEPS = 16;
/**
 * Tek arac cagrisinin ust suresi (arkadaki kacak korumasi). Cihaz koprusunun
 * kendi zaman asimindan (30 sn, `device_timeout`) BILINCLI buyuk: koprunun
 * daha ozel hatasi once gelsin, bu tavan yalniz sureyi hic gozetmeyen araclar
 * icindir.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
  const { model, registry, scope, guards = [], deviceBridge, signal, onDelta } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  const messages: LoopMessage[] = [...options.messages];
  let inputTokens = 0;
  let outputTokens = 0;
  let lastText = '';

  const usage = (): TokenUsage => ({ inputTokens, outputTokens });

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) {
      return { stopReason: 'cancelled', text: lastText, messages, usage: usage() };
    }

    let result: LoopModelResult;
    try {
      const request: LoopModelRequest = {
        messages,
        tools: registry.specs(),
        ...(signal ? { signal } : {}),
        ...(onDelta ? { onDelta } : {}),
      };
      result = await model.generate(request);
    } catch (error) {
      if (signal?.aborted) {
        return { stopReason: 'cancelled', text: lastText, messages, usage: usage() };
      }
      return { stopReason: 'error', text: lastText, messages, usage: usage(), error };
    }

    if (result.usage) {
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
    }
    lastText = result.text;

    const toolCalls = result.toolCalls;
    messages.push({
      role: 'assistant',
      content: result.text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      const stopReason: TurnStopReason = result.stop === 'max_tokens' ? 'max_tokens' : 'end_turn';
      return { stopReason, text: lastText, messages, usage: usage() };
    }

    // Son adimda arac istenirse sonucunu modele geri verecek adim kalmadi:
    // yan etkisi sonucsuz kalacak araci baslatmayiz.
    if (step === maxSteps - 1) {
      return { stopReason: 'max_steps', text: lastText, messages, usage: usage() };
    }

    for (const call of toolCalls) {
      if (signal?.aborted) {
        return { stopReason: 'cancelled', text: lastText, messages, usage: usage() };
      }
      const toolResult = await executeToolCall({
        call,
        registry,
        guards,
        scope,
        ...(deviceBridge ? { deviceBridge } : {}),
        ...(signal ? { signal } : {}),
        timeoutMs: toolTimeoutMs,
      });
      messages.push({
        role: 'tool',
        toolCallId: call.toolCallId,
        ok: toolResult.ok,
        result: toolResult.result,
      });
    }
  }

  return { stopReason: 'max_steps', text: lastText, messages, usage: usage() };
}

interface ExecuteArgs {
  readonly call: ToolCall;
  readonly registry: ToolRegistry;
  readonly guards: readonly ToolGuard[];
  readonly scope: Scope;
  readonly deviceBridge?: DeviceToolBridge;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

async function executeToolCall(args: ExecuteArgs): Promise<ToolResult> {
  const { call, registry, guards, scope, deviceBridge, signal, timeoutMs } = args;
  const deny = (result: unknown): ToolResult => ({
    toolCallId: call.toolCallId,
    ok: false,
    result,
  });

  const tool = registry.get(call.name);
  if (!tool) {
    return deny({ error: 'unknown_tool', name: call.name });
  }

  const parsed = tool.parameters.safeParse(call.input);
  if (!parsed.success) {
    return deny({
      error: 'invalid_input',
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }

  const guardReason = evaluateGuards(guards, { tool, input: parsed.data, scope });
  if (guardReason !== undefined) {
    return deny({ denied: guardReason });
  }

  // Arac KENDI sinyalini alir: tur iptal edilince ya da sure dolunca bu sinyal
  // araci (ve onun uzak istegini) durdurur; sureyi gozetmeyen arac turu asamaz.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const execution = (async (): Promise<ToolResult> => {
      if (tool.locus === 'device') {
        if (!deviceBridge) {
          return deny({ error: 'no_device_bridge', name: call.name });
        }
        return deviceBridge(call, { scope, signal: controller.signal });
      }
      if (!tool.execute) {
        // defineTool server araci icin execute'u garanti eder; yine de fail-closed.
        return deny({ error: 'no_executor', name: call.name });
      }
      const value = await tool.execute(parsed.data, { scope, signal: controller.signal });
      return { toolCallId: call.toolCallId, ok: true, result: value };
    })();
    // Sure dolarsa arac sonradan hata verse bile kimseye ulasmaz.
    execution.catch(() => undefined);

    const timeout = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`Arac zaman asimi: ${timeoutMs}ms`));
        resolve(deny({ error: 'tool_timeout' }));
      }, timeoutMs);
    });
    return await Promise.race([execution, timeout]);
  } catch (error) {
    return deny({
      error: 'tool_threw',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
