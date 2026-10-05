import OpenAI from 'openai';

import {
  LlmError,
  type ChatMessage,
  type ChatResult,
  type ChatUsage,
  type LlmProvider,
  type RoleConfig,
  type StreamOptions,
  type ToolCall,
  type ToolChatResult,
  type ToolDefinition,
  type ToolMessage,
  type ToolStopReason,
} from '../types.js';

/**
 * OpenAI-uyumlu endpoint saglayicisi: Ollama (/v1), OpenRouter, LM Studio,
 * Gemini OpenAI-uyumlu ucu… Tek implementasyon, baseUrl ile secilir.
 */
export function createOpenAiCompatProvider(input: {
  baseUrl: string;
  apiKey?: string;
}): LlmProvider {
  const client = new OpenAI({
    baseURL: input.baseUrl,
    // Ollama anahtar istemez ama SDK bos deger kabul etmez.
    apiKey: input.apiKey ?? 'not-required',
  });

  return {
    kind: 'openai-compat',
    async streamChat(
      config: RoleConfig,
      messages: ChatMessage[],
      options: StreamOptions = {},
    ): Promise<ChatResult> {
      try {
        const stream = await client.chat.completions.create(
          {
            model: config.model,
            messages,
            max_tokens: config.maxOutputTokens,
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            stream: true,
            // Son chunk'ta gercek token sayilari gelsin (Ollama destekliyor).
            stream_options: { include_usage: true },
          },
          {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.singleAttempt ? { maxRetries: 0 } : {}),
          },
        );

        let text = '';
        let usage: ChatUsage | undefined;
        let finishReason: string | null | undefined;

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          const delta = choice?.delta?.content;
          if (delta) {
            text += delta;
            options.onDelta?.(delta);
          }
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            };
          }
          if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
            finishReason = choice.finish_reason;
          }
        }

        if (finishReason !== 'stop' && finishReason !== 'length') {
          throw new LlmError(
            `OpenAI-uyumlu endpoint basarisiz finish reason dondurdu: ${finishReason ?? 'yok'}.`,
            'openai-compat',
          );
        }
        if (!text.trim()) {
          throw new LlmError('OpenAI-uyumlu endpoint bos sonuc dondurdu.', 'openai-compat');
        }

        return usage ? { text, usage } : { text };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof LlmError) throw error;
        throw new LlmError(
          `OpenAI-uyumlu endpoint istegi basarisiz (${input.baseUrl}).`,
          'openai-compat',
          { cause: error },
        );
      }
    },

    async generateWithTools(
      config: RoleConfig,
      messages: readonly ToolMessage[],
      tools: readonly ToolDefinition[],
      options: StreamOptions = {},
    ): Promise<ToolChatResult> {
      const oaMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => {
        if (m.role === 'assistant') {
          const calls = m.toolCalls ?? [];
          if (calls.length === 0) return { role: 'assistant', content: m.content };
          const toolCalls = calls.map((tc) => {
            const fn = {
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            };
            // Gemini thought_signature'i round-1'de ne geldiyse AYNEN geri koy
            // (extra_content). Yoksa alan hic eklenmez.
            return tc.providerMeta !== undefined ? { ...fn, extra_content: tc.providerMeta } : fn;
          });
          // `extra_content` degisken (toolCalls) uzerinden gelir → fresh-literal
          // excess-property kontrolu tetiklenmez, assertion gerekmez. content:
          // tool_call'li asistanda null olmali — Gemini bos-string'i 400 ile
          // reddediyor.
          return {
            role: 'assistant',
            content: m.content.length > 0 ? m.content : null,
            tool_calls: toolCalls,
          };
        }
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        }
        return { role: m.role, content: m.content };
      });

      try {
        // stream:false ZORUNLU. Iki sebep: (1) tool-loop turu ciktiyi
        // stream'lemiyor (run-turn onDelta gecmez); (2) Gemini thought_signature'i
        // (cok-turlu tool cagrisi icin sart) yalniz stream-DISI yanitin
        // tool_calls[].extra_content'inde geliyor.
        const resp = await client.chat.completions.create(
          {
            model: config.model,
            messages: oaMessages,
            max_tokens: config.maxOutputTokens,
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            stream: false,
            ...(tools.length > 0
              ? {
                  tools: tools.map((t) => ({
                    type: 'function' as const,
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters,
                    },
                  })),
                }
              : {}),
          },
          {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.singleAttempt ? { maxRetries: 0 } : {}),
          },
        );

        const choice = resp.choices[0];
        const message = choice?.message;
        const text = message?.content ?? '';
        // Stream yok: metin tek parca. Caller onDelta beklerse bir kez yayinla.
        if (text) options.onDelta?.(text);

        const toolCalls: ToolCall[] = (message?.tool_calls ?? []).flatMap((tc) => {
          if (tc.type !== 'function') return [];
          // Gemini thought_signature'i buradan gelir; opak, YALNIZ round-2 echo'su
          // icin tasinir (bkz. ToolCall.providerMeta / ADR 0008).
          const meta = (tc as unknown as { extra_content?: unknown }).extra_content;
          const base: ToolCall = {
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          };
          return [meta !== undefined ? { ...base, providerMeta: meta } : base];
        });

        // Yalniz taninan BASARILI bitisler kabul edilir: `content_filter`, `safety`
        // ya da bilinmeyen/eksik bitis sessizce `end_turn` sayilirsa kesik ya da
        // bos cevap basarili tamamlanmis gibi sunulurdu.
        const finishReason = choice?.finish_reason ?? undefined;
        const successfulFinish =
          finishReason === 'stop' || finishReason === 'length' || finishReason === 'tool_calls';
        if (!successfulFinish) {
          throw new LlmError(
            `OpenAI-uyumlu endpoint basarisiz finish reason dondurdu: ${finishReason ?? 'yok'}.`,
            'openai-compat',
          );
        }
        if (toolCalls.length === 0) {
          if (finishReason === 'tool_calls') {
            throw new LlmError(
              'OpenAI-uyumlu endpoint tool_calls bitirdi ama arac cagrisi dondurmedi.',
              'openai-compat',
            );
          }
          if (!text.trim()) {
            throw new LlmError('OpenAI-uyumlu endpoint bos sonuc dondurdu.', 'openai-compat');
          }
        }
        const stop: ToolStopReason =
          finishReason === 'tool_calls'
            ? 'tool_use'
            : finishReason === 'length'
              ? 'max_tokens'
              : 'end_turn';
        const usage: ChatUsage | undefined = resp.usage
          ? { inputTokens: resp.usage.prompt_tokens, outputTokens: resp.usage.completion_tokens }
          : undefined;

        return usage ? { text, toolCalls, stop, usage } : { text, toolCalls, stop };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof LlmError) throw error;
        throw new LlmError(
          `OpenAI-uyumlu tool istegi basarisiz (${input.baseUrl}).`,
          'openai-compat',
          { cause: error },
        );
      }
    },
  };
}
