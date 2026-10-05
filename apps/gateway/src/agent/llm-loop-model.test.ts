import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LoopModelRequest } from '@smith/core';
import type { LlmRouter } from '@smith/llm';
import { createLlmLoopModel } from './llm-loop-model.js';

function fakeRouter(result: unknown): { router: LlmRouter; gen: ReturnType<typeof vi.fn> } {
  const gen = vi.fn().mockResolvedValue(result);
  const router = { streamChat: vi.fn(), generateWithTools: gen } as unknown as LlmRouter;
  return { router, gen };
}

describe('createLlmLoopModel', () => {
  const req: LoopModelRequest = {
    messages: [
      { role: 'system', content: 'sen smith' },
      { role: 'user', content: 'selam' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ toolCallId: 'tc_1', name: 'ara', input: { q: 'x' } }],
      },
      { role: 'tool', toolCallId: 'tc_1', ok: true, result: { hit: 1 } },
    ],
    tools: [{ name: 'ara', description: 'arar', parameters: z.object({ q: z.string() }) }],
  };

  it('core -> llm cevirir ve sonucu geri cevirir', async () => {
    const { router, gen } = fakeRouter({
      text: 'buldum',
      toolCalls: [{ id: 'tc_2', name: 'ara', arguments: '{"q":"y"}' }],
      stop: 'tool_use',
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    const model = createLlmLoopModel(router, 'chat');
    const result = await model.generate(req);

    expect(result).toEqual({
      text: 'buldum',
      toolCalls: [{ toolCallId: 'tc_2', name: 'ara', input: { q: 'y' } }],
      stop: 'tool_use',
      usage: { inputTokens: 3, outputTokens: 4 },
    });

    const [role, msgs, tools] = gen.mock.lastCall as [string, unknown[], unknown[]];
    expect(role).toBe('chat');
    expect(msgs[2]).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'ara', arguments: '{"q":"x"}' }],
    });
    expect(msgs[3]).toEqual({
      role: 'tool',
      toolCallId: 'tc_1',
      content: '{"ok":true,"result":{"hit":1}}',
    });
    expect(tools[0]).toEqual({
      name: 'ara',
      description: 'arar',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    });
  });

  it('usage yoksa alan olusmaz', async () => {
    const { router } = fakeRouter({ text: 'ok', toolCalls: [], stop: 'end_turn' });
    const model = createLlmLoopModel(router, 'chat');
    const result = await model.generate({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(result).toEqual({ text: 'ok', toolCalls: [], stop: 'end_turn' });
    expect('usage' in result).toBe(false);
  });
});
