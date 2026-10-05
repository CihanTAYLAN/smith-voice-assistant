import { describe, expect, it, vi } from 'vitest';

import { createAnthropicProvider } from './anthropic.js';
import { createOpenAiCompatProvider } from './openai-compat.js';
import type { RoleConfig, ToolDefinition } from '../types.js';

const { oaCreate, anthropicStream } = vi.hoisted(() => ({
  oaCreate: vi.fn(),
  anthropicStream: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: oaCreate } };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn(), stream: anthropicStream };
  },
}));

/**
 * Anthropic `messages.stream(...)` sahtesi: gercek SDK gibi 'text' olayini
 * YALNIZ text bloklari icin yayar (thinking/reasoning yaymaz), `finalMessage`
 * ile tam icerigi dondurur.
 */
function anthropicStreamOf(
  content: unknown[],
  usage: { input_tokens: number; output_tokens: number },
  stopReason: string,
): { on: (e: string, cb: (d: string) => void) => void; finalMessage: () => Promise<unknown> } {
  return {
    on(event: string, cb: (d: string) => void) {
      if (event === 'text') {
        for (const b of content as { type: string; text?: string }[]) {
          if (b.type === 'text' && b.text) cb(b.text);
        }
      }
    },
    finalMessage: () => Promise.resolve({ content, stop_reason: stopReason, usage }),
  };
}

const tools: ToolDefinition[] = [
  {
    name: 'echo',
    description: 'yankilar',
    parameters: { type: 'object', properties: { v: { type: 'number' } } },
  },
];

describe('openai-compat generateWithTools (non-stream)', () => {
  const cfg: RoleConfig = {
    provider: 'openai-compat',
    model: 'gemini-flash',
    maxOutputTokens: 100,
  };

  it('tool_calls parse edilir; finish_reason tool_calls -> tool_use; stream:false gonderilir', async () => {
    oaCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'ok',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"v":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    const r = await provider.generateWithTools(cfg, [{ role: 'user', content: 'hi' }], tools);
    expect(r.text).toBe('ok');
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'echo', arguments: '{"v":1}' }]);
    expect(r.stop).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    const arg = oaCreate.mock.lastCall?.[0] as {
      stream?: boolean;
      tools?: { function: { name: string } }[];
    };
    expect(arg.stream).toBe(false);
    expect(arg.tools?.[0]?.function.name).toBe('echo');
  });

  it('onDelta metnin tamamiyla BIR kez cagrilir (stream yok)', async () => {
    oaCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Merhaba' }, finish_reason: 'stop' }],
    });
    const deltalar: string[] = [];
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    const r = await provider.generateWithTools(cfg, [{ role: 'user', content: 'hi' }], tools, {
      onDelta: (d) => deltalar.push(d),
    });
    expect(deltalar).toEqual(['Merhaba']);
    expect(r.text).toBe('Merhaba');
    expect(r.stop).toBe('end_turn');
  });

  it('gecmis: assistant tool_calls content NULL + thought_signature echo + tool sonucu', async () => {
    oaCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'bitti' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    const r = await provider.generateWithTools(
      cfg,
      [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'echo',
              arguments: '{}',
              providerMeta: { google: { thought_signature: 'SIG' } },
            },
          ],
        },
        { role: 'tool', toolCallId: 'c1', content: 'sonuc' },
      ],
      tools,
    );
    expect(r.stop).toBe('end_turn');
    const arg = oaCreate.mock.lastCall?.[0] as {
      messages: {
        role: string;
        content?: string | null;
        tool_call_id?: string;
        tool_calls?: { id: string; extra_content?: unknown }[];
      }[];
    };
    expect(arg.messages).toContainEqual({ role: 'tool', tool_call_id: 'c1', content: 'sonuc' });
    const assistant = arg.messages[1];
    // Gemini 400 fix: tool_call'li asistanda bos-string content -> null.
    expect(assistant?.content).toBeNull();
    expect(assistant?.tool_calls?.[0]?.id).toBe('c1');
    // thought_signature round-2'ye AYNEN geri konur (extra_content).
    expect(assistant?.tool_calls?.[0]?.extra_content).toEqual({
      google: { thought_signature: 'SIG' },
    });
  });

  it('tool_call extra_content -> providerMeta olarak yakalanir (imza koprusu)', async () => {
    oaCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'echo', arguments: '{}' },
                extra_content: { google: { thought_signature: 'SIG' } },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    const r = await provider.generateWithTools(cfg, [{ role: 'user', content: 'hi' }], tools);
    expect(r.toolCalls[0]?.providerMeta).toEqual({ google: { thought_signature: 'SIG' } });
  });

  it('ADR 0008: yanittaki reasoning_content sonuca/metne SIZMAZ', async () => {
    oaCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'cevap',
            reasoning_content: 'SIZINTI_MUHAKEME',
            reasoning: 'SIZINTI_MUHAKEME',
          },
          finish_reason: 'stop',
        },
      ],
    });
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    const r = await provider.generateWithTools(cfg, [{ role: 'user', content: 'hi' }], tools);
    expect(r.text).toBe('cevap');
    expect(JSON.stringify(r)).not.toContain('SIZINTI_MUHAKEME');
  });

  it.each(['content_filter', 'safety', 'function_call', undefined])(
    'taninmayan ya da filtreli bitis (%s) basarili end_turn sayilmaz',
    async (finishReason) => {
      oaCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'kismi' }, finish_reason: finishReason }],
      });
      const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
      await expect(
        provider.generateWithTools(cfg, [{ role: 'user', content: 'hi' }], tools),
      ).rejects.toThrow(/finish reason/i);
    },
  );

  it('stop ile biten bos sonucu hata sayar', async () => {
    oaCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '  ' }, finish_reason: 'stop' }],
    });
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    await expect(
      provider.generateWithTools(cfg, [{ role: 'user', content: 'hi' }], tools),
    ).rejects.toThrow(/bos sonuc/i);
  });

  it('tool_calls bitisinde arac cagrisi yoksa hata sayar', async () => {
    oaCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }],
    });
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    await expect(
      provider.generateWithTools(cfg, [{ role: 'user', content: 'hi' }], tools),
    ).rejects.toThrow(/arac cagrisi dondurmedi/i);
  });

  it('arac cagrisi donduren yanit bos metinle ve stop bitisiyle de gecerlidir', async () => {
    oaCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{}' } },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    });
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    const result = await provider.generateWithTools(cfg, [{ role: 'user', content: 'hi' }], tools);
    expect(result.toolCalls).toHaveLength(1);
  });

  it('length bitisi kismi metinle kabul edilir (max_tokens)', async () => {
    oaCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'kesik cevap' }, finish_reason: 'length' }],
    });
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    const result = await provider.generateWithTools(cfg, [{ role: 'user', content: 'hi' }], tools);
    expect(result).toMatchObject({ text: 'kesik cevap', stop: 'max_tokens' });
  });
});

describe('openai-compat streamChat finish reason', () => {
  const streamCfg: RoleConfig = { provider: 'openai-compat', model: 'x', maxOutputTokens: 10 };

  function streamOf(...chunks: unknown[]) {
    return {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (const chunk of chunks) yield chunk;
      },
    };
  }

  it('safety/content_filter bitisini acik hata yapar', async () => {
    oaCreate.mockResolvedValueOnce(
      streamOf({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }),
    );
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    await expect(provider.streamChat(streamCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /finish reason/i,
    );
  });

  it('finish_reason hic gelmeden kesilen akisi basarili saymaz', async () => {
    oaCreate.mockResolvedValueOnce(streamOf({ choices: [{ delta: { content: 'yari' } }] }));
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });
    await expect(provider.streamChat(streamCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /finish reason/i,
    );
  });

  it('stop ile biten bos akis hatadir; metinli akis basarilidir', async () => {
    const provider = createOpenAiCompatProvider({ baseUrl: 'http://x/v1' });

    oaCreate.mockResolvedValueOnce(streamOf({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    await expect(provider.streamChat(streamCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /bos sonuc/i,
    );

    oaCreate.mockResolvedValueOnce(
      streamOf({ choices: [{ delta: { content: 'tamam' }, finish_reason: 'stop' }] }),
    );
    await expect(
      provider.streamChat(streamCfg, [{ role: 'user', content: 'hi' }]),
    ).resolves.toMatchObject({ text: 'tamam' });
  });
});

describe('anthropic generateWithTools', () => {
  const cfg: RoleConfig = { provider: 'anthropic', model: 'claude-sonnet-5', maxOutputTokens: 100 };

  it('streaming: tool_use parse edilir; stop_reason tool_use', async () => {
    anthropicStream.mockReturnValueOnce(
      anthropicStreamOf(
        [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'echo', input: { v: 1 } },
        ],
        { input_tokens: 4, output_tokens: 2 },
        'tool_use',
      ),
    );
    const provider = createAnthropicProvider('k');
    const r = await provider.generateWithTools(cfg, [{ role: 'user', content: 'x' }], tools);
    expect(r.text).toBe('hi');
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'echo', arguments: '{"v":1}' }]);
    expect(r.stop).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });

  it('onDelta yalniz text bloklarini yayar (streaming, ADR 0008)', async () => {
    anthropicStream.mockReturnValueOnce(
      anthropicStreamOf(
        [
          { type: 'thinking', thinking: 'SIZINTI_MUHAKEME' },
          { type: 'text', text: 'selam' },
        ],
        { input_tokens: 1, output_tokens: 1 },
        'end_turn',
      ),
    );
    const deltalar: string[] = [];
    const provider = createAnthropicProvider('k');
    const r = await provider.generateWithTools(cfg, [{ role: 'user', content: 'x' }], tools, {
      onDelta: (d) => deltalar.push(d),
    });
    expect(deltalar).toEqual(['selam']);
    expect(deltalar.join('')).not.toContain('SIZINTI_MUHAKEME');
    expect(r.text).toBe('selam');
  });

  it('ADR 0008: thinking blogu DUSURULUR (metne/sonuca sizmaz)', async () => {
    anthropicStream.mockReturnValueOnce(
      anthropicStreamOf(
        [
          { type: 'thinking', thinking: 'SIZINTI_MUHAKEME' },
          { type: 'text', text: 'cevap' },
        ],
        { input_tokens: 1, output_tokens: 1 },
        'end_turn',
      ),
    );
    const provider = createAnthropicProvider('k');
    const r = await provider.generateWithTools(cfg, [{ role: 'user', content: 'x' }], tools);
    expect(r.text).toBe('cevap');
    expect(JSON.stringify(r)).not.toContain('SIZINTI_MUHAKEME');
  });
});
