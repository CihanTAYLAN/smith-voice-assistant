import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@smith/core';
import type { LoopModel } from '@smith/core';
import type { DbHandle } from '@smith/db';
import { createWorkspaceScope } from '@smith/tenancy';

const { appendMessage, listSessionMessages, tx } = vi.hoisted(() => ({
  appendMessage: vi.fn().mockResolvedValue({ id: 'msg_0123456789abcdefghij' }),
  listSessionMessages: vi.fn().mockResolvedValue([]),
  tx: {
    session: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ses_0123456789abcdefghij' }),
    },
    message: {
      create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('@smith/db', () => ({
  withScope: (_prisma: unknown, _scope: unknown, fn: (value: unknown) => unknown) => fn(tx),
  appendMessage,
  listSessionMessages,
  newMessageId: () => 'msg_generated1234567890ab',
}));

import { AgentTurnIncompleteError, runAgentChatTurn } from './run-turn.js';

const scope = createWorkspaceScope({
  workspaceId: 'ws_0123456789abcdefghij',
  actorId: 'act_0123456789abcdefghij',
  role: 'owner',
});

describe('runAgentChatTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSessionMessages.mockResolvedValue([]);
    tx.message.findMany.mockResolvedValue([]);
    tx.session.findFirst.mockResolvedValue({ id: 'ses_0123456789abcdefghij' });
    tx.message.findFirst.mockReset().mockResolvedValue(null);
    tx.message.create.mockReset().mockImplementation(({ data }) => Promise.resolve(data));
    tx.message.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loop turu yaniti akitir, kalici yazar, stopReason doner', async () => {
    const model: LoopModel = {
      generate: () =>
        Promise.resolve({
          text: 'merhaba',
          toolCalls: [],
          stop: 'end_turn',
          usage: { inputTokens: 3, outputTokens: 4 },
        }),
    };
    const deltas: string[] = [];
    const result = await runAgentChatTurn({
      db: { prisma: {} } as unknown as DbHandle,
      model,
      registry: new ToolRegistry(),
      scope,
      sessionId: 'ses_0123456789abcdefghij',
      userText: 'selam',
      onDelta: (d) => deltas.push(d),
    });
    expect(result.text).toBe('merhaba');
    expect(result.stopReason).toBe('end_turn');
    expect(result.inputTokens).toBe(3);
    expect(result.outputTokens).toBe(4);
    expect(deltas).toEqual(['merhaba']);
  });

  it('en yeni 50 mesaji kronolojik sirayla modele verir', async () => {
    const generate = vi.fn<LoopModel['generate']>().mockResolvedValue({
      text: 'cevap',
      toolCalls: [],
      stop: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const model: LoopModel = {
      generate,
    };
    const oldestFifty = Array.from({ length: 50 }, (_, index) => ({
      id: `msg_${index.toString().padStart(20, '0')}`,
      authorRole: index % 2 === 0 ? 'user' : 'assistant',
      text: `eski-${index}`,
      createdAt: new Date(index),
    }));
    listSessionMessages.mockResolvedValue(oldestFifty);
    tx.message.findMany.mockResolvedValue([
      { authorRole: 'user', text: 'en-yeni', createdAt: new Date(51), id: 'msg_new' },
      ...oldestFifty.slice(1).reverse(),
    ]);

    await runAgentChatTurn({
      db: { prisma: {} } as unknown as DbHandle,
      model,
      registry: new ToolRegistry(),
      scope,
      sessionId: 'ses_0123456789abcdefghij',
      userText: 'en-yeni',
      onDelta: () => undefined,
    });

    const request = generate.mock.calls[0]?.[0];
    expect(
      request?.messages.some((message) => message.role !== 'tool' && message.content === 'en-yeni'),
    ).toBe(true);
  });

  it('asili indeks enqueue islemini yanit yolunda beklemez', async () => {
    const model: LoopModel = {
      generate: () =>
        Promise.resolve({
          text: 'cevap',
          toolCalls: [],
          stop: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
    };
    const never = new Promise<void>(() => undefined);

    const outcome = await Promise.race([
      runAgentChatTurn({
        db: { prisma: {} } as unknown as DbHandle,
        model,
        registry: new ToolRegistry(),
        indexMessage: () => never,
        scope,
        sessionId: 'ses_0123456789abcdefghij',
        userText: 'selam',
        onDelta: () => undefined,
      }).then(() => 'done'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(outcome).toBe('done');
  });

  it('tamamlanmis duplicate turda modeli ve arac dongusunu yeniden calistirmaz', async () => {
    const generate = vi.fn<LoopModel['generate']>().mockResolvedValue({
      text: 'ilk-cevap',
      toolCalls: [],
      stop: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    const model: LoopModel = {
      generate,
    };
    tx.message.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ text: 'selam' })
      .mockResolvedValueOnce({
        id: 'msg_assistant1234567890ab',
        authorRole: 'assistant',
        text: 'ilk-cevap',
        inputTokens: 2,
        outputTokens: 3,
      });
    const input = {
      db: { prisma: {} } as unknown as DbHandle,
      model,
      registry: new ToolRegistry(),
      idempotencyKey: 'ayni-istek',
      scope,
      sessionId: 'ses_0123456789abcdefghij',
      userText: 'selam',
      onDelta: () => undefined,
    };

    await runAgentChatTurn(input);
    const replay = await runAgentChatTurn(input);

    expect(generate).toHaveBeenCalledOnce();
    expect(replay).toEqual({
      text: 'ilk-cevap',
      stopReason: 'end_turn',
      inputTokens: 2,
      outputTokens: 3,
    });
  });

  describe('basarisiz, iptal edilen ve adim sinirina takilan turlar', () => {
    const baseInput = (model: LoopModel, overrides: Record<string, unknown> = {}) => ({
      db: { prisma: {} } as unknown as DbHandle,
      model,
      registry: new ToolRegistry(),
      idempotencyKey: 'tekrar-edilen-istek',
      scope,
      sessionId: 'ses_0123456789abcdefghij',
      userText: 'selam',
      onDelta: vi.fn(),
      ...overrides,
    });

    const toolCall = { toolCallId: 'tc_0123456789abcdefghij', name: 'bilinmeyen', input: {} };

    it('model hatasinda bos metni asistan yaniti olarak YAZMAZ, claim i birakir, error frame icin firlatir', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const failure = Object.assign(new Error('429 gizli saglayici ayrintisi'), {
        name: 'RateLimitError',
      });
      const model: LoopModel = { generate: () => Promise.reject(failure) };
      const input = baseInput(model);

      const outcome = await runAgentChatTurn(input).catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(AgentTurnIncompleteError);
      expect((outcome as AgentTurnIncompleteError).stopReason).toBe('error');
      // Yalniz kullanici mesaji yazildi; asistan satiri YOK.
      expect(tx.message.create.mock.calls.map(([arg]) => arg.data.authorRole)).toEqual(['user']);
      expect(input.onDelta).not.toHaveBeenCalled();
      expect(tx.message.deleteMany).toHaveBeenCalledOnce();
      // Sebep maskeli loglanir: yalniz hata adi.
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).toContain('RateLimitError');
      expect(logged).not.toContain('gizli');
    });

    it('arac cagrisina eslik eden ara metin hata aninda kalici yazilmaz ve akitilmaz', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const generate = vi
        .fn<LoopModel['generate']>()
        .mockResolvedValueOnce({
          text: 'ara metin',
          toolCalls: [toolCall],
          stop: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockRejectedValueOnce(new Error('ikinci adim dustu'));
      const input = baseInput({ generate });

      await expect(runAgentChatTurn(input)).rejects.toBeInstanceOf(AgentTurnIncompleteError);

      expect(input.onDelta).not.toHaveBeenCalled();
      expect(tx.message.create).toHaveBeenCalledOnce();
    });

    it('adim sinirina takilan tur max_steps ile firlatir; cevap yazilmaz, claim birakilir', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const model: LoopModel = {
        generate: () =>
          Promise.resolve({
            text: 'yarim',
            toolCalls: [toolCall],
            stop: 'tool_use',
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
      };
      const input = baseInput(model);

      const outcome = await runAgentChatTurn(input).catch((error: unknown) => error);

      expect((outcome as AgentTurnIncompleteError).stopReason).toBe('max_steps');
      expect(input.onDelta).not.toHaveBeenCalled();
      expect(tx.message.create).toHaveBeenCalledOnce();
      expect(tx.message.deleteMany).toHaveBeenCalledOnce();
      expect(JSON.stringify(errorLog.mock.calls)).toContain('adim sinir');
    });

    it('iptal edilen tur kismi metni yazmaz, claim i birakir, hata loglamaz', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const controller = new AbortController();
      controller.abort();
      const generate = vi.fn<LoopModel['generate']>();
      const input = baseInput({ generate }, { signal: controller.signal });

      const outcome = await runAgentChatTurn(input).catch((error: unknown) => error);

      expect((outcome as AgentTurnIncompleteError).stopReason).toBe('cancelled');
      expect(generate).not.toHaveBeenCalled();
      expect(tx.message.create).toHaveBeenCalledOnce();
      expect(tx.message.deleteMany).toHaveBeenCalledOnce();
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('idempotency anahtari yokken birakilacak claim yoktur', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const model: LoopModel = { generate: () => Promise.reject(new Error('dustu')) };

      await expect(
        runAgentChatTurn(baseInput(model, { idempotencyKey: undefined })),
      ).rejects.toBeInstanceOf(AgentTurnIncompleteError);

      expect(tx.message.deleteMany).not.toHaveBeenCalled();
    });

    it('max_tokens ile biten tur hata degildir: yazilir ve stopReason max_tokens doner', async () => {
      const model: LoopModel = {
        generate: () =>
          Promise.resolve({
            text: 'kesik ama gecerli',
            toolCalls: [],
            stop: 'max_tokens',
            usage: { inputTokens: 5, outputTokens: 6 },
          }),
      };
      const input = baseInput(model);

      const result = await runAgentChatTurn(input);

      expect(result.stopReason).toBe('max_tokens');
      expect(input.onDelta).toHaveBeenCalledWith('kesik ama gecerli');
      expect(tx.message.deleteMany).not.toHaveBeenCalled();
      expect(tx.message.create).toHaveBeenCalledTimes(2);
    });
  });
});
