import type {
  LoopMessage,
  LoopModel,
  LoopModelRequest,
  LoopModelResult,
  ToolCall as CoreToolCall,
} from '@smith/core';
import type { LlmRole, LlmRouter, StreamOptions, ToolDefinition, ToolMessage } from '@smith/llm';

import { zodToJsonSchema } from './tool-schema.js';

/**
 * `packages/core`'un `LoopModel` dikisini `@smith/llm`'in tool-calling'ine
 * baglayan adapter. Ceviriyi tek yerde tutar; core saglayici-notr, llm
 * core-habersiz kalir. ADR 0008: yalniz text + SEFFAF tool_use/tool_result
 * tasinir (llm katmani thinking/reasoning'i zaten dusuruyor).
 *
 * IMZA KOPRUSU: Gemini cok-turlu tool cagrisini yalniz round-1'deki
 * `thought_signature` round-2'de geri verilirse kabul eder (yoksa 400). Bu imza
 * saglayiciya-opak; core `LoopMessage`'a KOYULMAZ (opaque-blocks invariant'i:
 * core replay edilebilir ciphertext tasimaz). Bunun yerine adapter, imzayi
 * `toolCallId -> meta` olarak TUR-ICI bir haritada tutar: round-1 sonucundan
 * toplar, round-2 istegini kurarken geri koyar. Harita bu ornekle yasar; gateway
 * ornegi TUR BASINA yaratir (index.ts) → izole, kalici degil, saglayicilar arasi
 * gecmez.
 */
export function createLlmLoopModel(router: LlmRouter, role: LlmRole): LoopModel {
  const metaByCallId = new Map<string, unknown>();

  function toLlmMessage(m: LoopMessage): ToolMessage {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant':
        return m.toolCalls && m.toolCalls.length > 0
          ? {
              role: 'assistant',
              content: m.content,
              toolCalls: m.toolCalls.map((tc) => {
                const base = {
                  id: tc.toolCallId,
                  name: tc.name,
                  arguments: JSON.stringify(tc.input),
                };
                // Round-1'de yakalanan imzayi (varsa) round-2 echo'suna geri koy.
                const meta = metaByCallId.get(tc.toolCallId);
                return meta !== undefined ? { ...base, providerMeta: meta } : base;
              }),
            }
          : { role: 'assistant', content: m.content };
      case 'tool':
        // core sonucu {ok, result} -> modele okunabilir tek string
        return {
          role: 'tool',
          toolCallId: m.toolCallId,
          content: JSON.stringify({ ok: m.ok, result: m.result }),
        };
    }
  }

  return {
    async generate(request: LoopModelRequest): Promise<LoopModelResult> {
      const messages: ToolMessage[] = request.messages.map(toLlmMessage);
      const tools: ToolDefinition[] = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.parameters),
      }));
      const options: StreamOptions = {
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onDelta ? { onDelta: request.onDelta } : {}),
      };

      const result = await router.generateWithTools(role, messages, tools, options);

      const toolCalls: CoreToolCall[] = result.toolCalls.map((tc) => {
        // Opak imzayi koprude sakla; core ToolCall'a KOYMA (core temiz kalir).
        if (tc.providerMeta !== undefined) metaByCallId.set(tc.id, tc.providerMeta);
        return { toolCallId: tc.id, name: tc.name, input: parseInput(tc.arguments) };
      });

      return {
        text: result.text,
        toolCalls,
        stop: result.stop,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  };
}

function parseInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
