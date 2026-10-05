import Anthropic from '@anthropic-ai/sdk';

import {
  LlmError,
  type ChatMessage,
  type ChatResult,
  type LlmProvider,
  type RoleConfig,
  type StreamOptions,
  type ToolCall,
  type ToolChatResult,
  type ToolDefinition,
  type ToolMessage,
  type ToolStopReason,
} from '../types.js';

/** Arac argumani daima obje olmali; bozuk JSON gelirse bos obje. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createAnthropicProvider(apiKey: string): LlmProvider {
  const client = new Anthropic({ apiKey });

  return {
    kind: 'anthropic',
    async streamChat(
      config: RoleConfig,
      messages: ChatMessage[],
      options: StreamOptions = {},
    ): Promise<ChatResult> {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const turns = messages
        .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const stream = client.messages.stream(
          {
            model: config.model,
            max_tokens: config.maxOutputTokens,
            ...(system ? { system } : {}),
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            messages: turns,
          },
          {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.singleAttempt ? { maxRetries: 0 } : {}),
          },
        );

        stream.on('text', (delta) => options.onDelta?.(delta));
        const final = await stream.finalMessage();

        const text = final.content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('');

        return {
          text,
          usage: {
            inputTokens: final.usage.input_tokens,
            outputTokens: final.usage.output_tokens,
          },
        };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new LlmError('Anthropic istegi basarisiz.', 'anthropic', { cause: error });
      }
    },

    async generateWithTools(
      config: RoleConfig,
      messages: readonly ToolMessage[],
      tools: readonly ToolDefinition[],
      options: StreamOptions = {},
    ): Promise<ToolChatResult> {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');

      const turns: Anthropic.MessageParam[] = [];
      for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'user') {
          turns.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
          const blocks: Anthropic.ContentBlockParam[] = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const tc of m.toolCalls ?? []) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: parseArgs(tc.arguments),
            });
          }
          turns.push({ role: 'assistant', content: blocks });
        } else {
          // tool sonucu → tool_result blogu tasiyan user mesaji
          turns.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
          });
        }
      }

      try {
        const stream = client.messages.stream(
          {
            model: config.model,
            max_tokens: config.maxOutputTokens,
            ...(system ? { system } : {}),
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            messages: turns,
            ...(tools.length > 0
              ? {
                  tools: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.parameters as Anthropic.Tool.InputSchema,
                  })),
                }
              : {}),
          },
          {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.singleAttempt ? { maxRetries: 0 } : {}),
          },
        );

        // 'text' olayi YALNIZ text bloklari icin yayilir — thinking/reasoning
        // buradan akmaz (ADR 0008). streamChat ile ayni desen.
        stream.on('text', (delta) => options.onDelta?.(delta));
        const final = await stream.finalMessage();

        let text = '';
        const toolCalls: ToolCall[] = [];
        for (const block of final.content) {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
            });
          }
          // thinking / redacted_thinking: DUSURULUR (ADR 0008)
        }

        const stop: ToolStopReason =
          final.stop_reason === 'tool_use'
            ? 'tool_use'
            : final.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : 'end_turn';

        return {
          text,
          toolCalls,
          stop,
          usage: {
            inputTokens: final.usage.input_tokens,
            outputTokens: final.usage.output_tokens,
          },
        };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new LlmError('Anthropic tool istegi basarisiz.', 'anthropic', { cause: error });
      }
    },
  };
}
