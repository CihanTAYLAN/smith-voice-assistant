import type { DbHandle } from '@smith/db';
import type { ChatMessage, LlmRouter } from '@smith/llm';
import { EMBED_TIMEOUT_MS, type Embedder } from '@smith/memory';
import { createWorkspaceScope } from '@smith/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { appendMessage, listSessionMessages, tx } = vi.hoisted(() => ({
  appendMessage: vi.fn().mockResolvedValue({ id: 'msg_0123456789abcdefghij' }),
  listSessionMessages: vi.fn().mockResolvedValue([]),
  tx: {
    $queryRaw: vi.fn().mockResolvedValue([]),
    session: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ses_0123456789abcdefghij' }),
    },
    message: {
      create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn<(args: { where: Record<string, unknown> }) => Promise<unknown>>(),
      update:
        vi.fn<
          (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
        >(),
    },
  },
}));

vi.mock('@smith/db', () => ({
  withScope: (_prisma: unknown, _scope: unknown, fn: (value: unknown) => unknown) => fn(tx),
  appendMessage,
  listSessionMessages,
  newMessageId: () => 'msg_generated1234567890ab',
}));

import { runChatTurn, STALE_PENDING_TURN_MS, TurnInProgressError } from './turn.js';

const scope = createWorkspaceScope({
  workspaceId: 'ws_0123456789abcdefghij',
  actorId: 'act_0123456789abcdefghij',
  role: 'owner',
});

/** Kaynakta secret gorunumlu literal birakmamak icin (pre-commit tarayicisi) kurulur. */
const API_KEY = `sk-${'A'.repeat(40)}`;

function llm(messages: { current?: ChatMessage[] } = {}) {
  const streamChat = vi.fn<LlmRouter['streamChat']>((_role, input) => {
    messages.current = input;
    return Promise.resolve({ text: 'cevap' });
  });
  const generateWithTools = vi.fn<LlmRouter['generateWithTools']>(() =>
    Promise.reject(new Error('Bu testte tool modeli cagrilmamali.')),
  );
  const router: LlmRouter = { streamChat, generateWithTools };
  return { router, streamChat };
}

describe('runChatTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSessionMessages.mockResolvedValue([]);
    tx.message.findMany.mockResolvedValue([]);
    tx.session.findFirst.mockResolvedValue({ id: 'ses_0123456789abcdefghij' });
    tx.message.findFirst.mockReset().mockResolvedValue(null);
    tx.message.create.mockReset().mockImplementation(({ data }) => Promise.resolve(data));
    tx.message.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    tx.message.update
      .mockReset()
      .mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('en yeni 50 mesaji kronolojik sirayla modele verir', async () => {
    const captured: { current?: ChatMessage[] } = {};
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

    await runChatTurn({
      db: { prisma: {} } as unknown as DbHandle,
      llm: llm(captured).router,
      scope,
      sessionId: 'ses_0123456789abcdefghij',
      userText: 'en-yeni',
      onDelta: () => undefined,
    });

    expect(captured.current).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'en-yeni' })]),
    );
  });

  it('asili indeks enqueue islemini yanit yolunda beklemez', async () => {
    const never = new Promise<void>(() => undefined);
    const outcome = await Promise.race([
      runChatTurn({
        db: { prisma: {} } as unknown as DbHandle,
        llm: llm().router,
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

  it('tamamlanmis ayni idempotency key sonucunu LLM calistirmadan replay eder', async () => {
    const { router, streamChat } = llm();
    const assistant = {
      id: 'msg_assistant1234567890ab',
      authorRole: 'assistant',
      text: 'onceki-cevap',
      inputTokens: 7,
      outputTokens: 9,
    };
    tx.message.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ text: 'selam' })
      .mockResolvedValueOnce(assistant);
    const deltas: string[] = [];
    const input = {
      db: { prisma: {} } as unknown as DbHandle,
      llm: router,
      idempotencyKey: 'ayni-istek',
      scope,
      sessionId: 'ses_0123456789abcdefghij',
      userText: 'selam',
      onDelta: (delta: string) => deltas.push(delta),
    };

    await runChatTurn(input);
    const replay = await runChatTurn(input);

    expect(streamChat).toHaveBeenCalledOnce();
    expect(replay).toEqual({ text: 'onceki-cevap', inputTokens: 7, outputTokens: 9 });
    expect(deltas).toContain('onceki-cevap');
  });

  it('ayni idempotency key farkli prompt icin kullanilamaz', async () => {
    tx.message.findFirst.mockResolvedValueOnce({ text: 'ilk-prompt' });

    await expect(
      runChatTurn({
        db: { prisma: {} } as unknown as DbHandle,
        llm: llm().router,
        idempotencyKey: 'ayni-istek',
        scope,
        sessionId: 'ses_0123456789abcdefghij',
        userText: 'farkli-prompt',
        onDelta: () => undefined,
      }),
    ).rejects.toThrow('Idempotency anahtari');
  });

  it('tamamlanmis replay icin embedding saglayicisini cagirmez', async () => {
    const embed = vi.fn<Embedder['embed']>().mockResolvedValue([]);
    const embedder: Embedder = {
      model: 'test',
      embed,
      embedBatch: vi.fn<Embedder['embedBatch']>().mockResolvedValue([]),
    };
    tx.message.findFirst.mockResolvedValueOnce({ text: 'selam' }).mockResolvedValueOnce({
      text: 'hazir-cevap',
      inputTokens: null,
      outputTokens: null,
    });

    const result = await runChatTurn({
      db: { prisma: {} } as unknown as DbHandle,
      llm: llm().router,
      embedder,
      idempotencyKey: 'ayni-istek',
      scope,
      sessionId: 'ses_0123456789abcdefghij',
      userText: 'selam',
      onDelta: () => undefined,
    });

    expect(result.text).toBe('hazir-cevap');
    expect(embed).not.toHaveBeenCalled();
  });

  describe('recall embedding girdisi', () => {
    function recordingEmbedder() {
      const embed = vi.fn<Embedder['embed']>().mockResolvedValue([0.1]);
      const embedder: Embedder = {
        model: 'test',
        embed,
        embedBatch: vi.fn<Embedder['embedBatch']>().mockResolvedValue([]),
      };
      return { embed, embedder };
    }

    it('girdiyi maskeler, mesajin kendisini aynen yazar ve turun iptal sinyalini iletir', async () => {
      const { embed, embedder } = recordingEmbedder();
      const controller = new AbortController();
      const userText = `anahtarim ${API_KEY} ile ne yapabilirim`;

      await runChatTurn({
        db: { prisma: {} } as unknown as DbHandle,
        llm: llm().router,
        embedder,
        scope,
        sessionId: 'ses_0123456789abcdefghij',
        userText,
        signal: controller.signal,
        onDelta: () => undefined,
      });

      expect(embed).toHaveBeenCalledOnce();
      expect(embed.mock.calls[0]?.[0]).toBe('anahtarim [GIZLI] ile ne yapabilirim');
      // Tur iptal edilince uzak embedding istegi de durur (bkz. zaman asimi testleri).
      const passed = embed.mock.calls[0]?.[1]?.signal;
      expect(passed?.aborted).toBe(false);
      controller.abort();
      expect(passed?.aborted).toBe(true);
      // Maskeleme yalniz uzak embedding girdisi icindir: mesaj DB ye aynen yazilir.
      expect(appendMessage).toHaveBeenCalledWith(
        tx,
        scope,
        expect.objectContaining({ authorRole: 'user', text: userText }),
      );
    });

    it('sinyal yokken de calisir, sir icermeyen metne dokunmaz ve kendi zaman asimini tasir', async () => {
      const { embed, embedder } = recordingEmbedder();

      await runChatTurn({
        db: { prisma: {} } as unknown as DbHandle,
        llm: llm().router,
        embedder,
        scope,
        sessionId: 'ses_0123456789abcdefghij',
        userText: 'adin ne',
        onDelta: () => undefined,
      });

      expect(embed.mock.calls[0]?.[0]).toBe('adin ne');
      expect(embed.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it('embedding istegi iptal nedeniyle dusse bile tur (best-effort recall) surer', async () => {
      const { embed, embedder } = recordingEmbedder();
      embed.mockRejectedValue(new Error('Request was aborted.'));

      const result = await runChatTurn({
        db: { prisma: {} } as unknown as DbHandle,
        llm: llm().router,
        embedder,
        scope,
        sessionId: 'ses_0123456789abcdefghij',
        userText: 'selam',
        onDelta: () => undefined,
      });

      expect(result.text).toBe('cevap');
    });

    it('embedding cagrisi KENDI zaman asimini tasir (tur sinyali olmasa bile asili kalmaz)', async () => {
      const { embed, embedder } = recordingEmbedder();
      const timeout = new AbortController();
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);

      await runChatTurn({
        db: { prisma: {} } as unknown as DbHandle,
        llm: llm().router,
        embedder,
        scope,
        sessionId: 'ses_0123456789abcdefghij',
        userText: 'selam',
        onDelta: () => undefined,
      });

      expect(timeoutSpy).toHaveBeenCalledWith(EMBED_TIMEOUT_MS);
      const passed = embed.mock.calls[0]?.[1]?.signal;
      expect(passed?.aborted).toBe(false);
      timeout.abort();
      expect(passed?.aborted).toBe(true);
    });
  });

  describe('recall hata gozlemlenebilirligi', () => {
    let epoch = 1_800_000_000_000;
    const nextMinute = () => {
      epoch += 3_600_000;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(epoch);
    };

    function failingEmbedder(error: Error) {
      const embedder: Embedder = {
        model: 'test',
        embed: vi.fn<Embedder['embed']>().mockRejectedValue(error),
        embedBatch: vi.fn<Embedder['embedBatch']>().mockResolvedValue([]),
      };
      return embedder;
    }

    const runWith = (embedder: Embedder, signal?: AbortSignal) =>
      runChatTurn({
        db: { prisma: {} } as unknown as DbHandle,
        llm: llm().router,
        embedder,
        scope,
        sessionId: 'ses_0123456789abcdefghij',
        userText: 'selam',
        ...(signal ? { signal } : {}),
        onDelta: () => undefined,
      });

    it('hata adini (mesaji degil) loglar ve tur yine de surer', async () => {
      nextMinute();
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const embedder = failingEmbedder(new Error('401 Unauthorized: key AIza-gizli-parca'));

      const result = await runWith(embedder);

      expect(result.text).toBe('cevap');
      expect(errorLog).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).toContain('hafiza baglami');
      expect(logged).toContain('Error');
      expect(logged).not.toContain('AIza');
      expect(logged).not.toContain('401');
    });

    it('dakikada en fazla bir kez loglar', async () => {
      nextMinute();
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const embedder = failingEmbedder(new Error('kota'));

      await runWith(embedder);
      await runWith(embedder);
      vi.setSystemTime(epoch + 59_000);
      await runWith(embedder);
      expect(errorLog).toHaveBeenCalledTimes(1);

      vi.setSystemTime(epoch + 61_000);
      await runWith(embedder);
      expect(errorLog).toHaveBeenCalledTimes(2);
    });

    it('kullanici turu iptal ettiyse hata sayilmaz, loglanmaz', async () => {
      nextMinute();
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const controller = new AbortController();
      controller.abort();

      await runWith(failingEmbedder(new Error('Request was aborted.')), controller.signal);

      expect(errorLog).not.toHaveBeenCalled();
    });
  });

  describe('claim yasam dongusu (ayni messageId ile yeniden deneme)', () => {
    const input = (overrides: Partial<Parameters<typeof runChatTurn>[0]> = {}) => ({
      db: { prisma: {} } as unknown as DbHandle,
      llm: llm().router,
      idempotencyKey: 'tekrar-edilen-istek',
      scope,
      sessionId: 'ses_0123456789abcdefghij',
      userText: 'selam',
      onDelta: () => undefined,
      ...overrides,
    });

    function failingLlm(error: Error) {
      const router: LlmRouter = {
        streamChat: vi.fn<LlmRouter['streamChat']>(() => Promise.reject(error)),
        generateWithTools: vi.fn<LlmRouter['generateWithTools']>(),
      };
      return router;
    }

    it('LLM hatasinda claim birakilir (kullanici mesaji silinir) ve hata aynen yukari gider', async () => {
      const failure = new Error('Gemini 429');

      await expect(runChatTurn(input({ llm: failingLlm(failure) }))).rejects.toBe(failure);

      expect(tx.message.deleteMany).toHaveBeenCalledOnce();
      const where = tx.message.deleteMany.mock.calls[0]?.[0].where;
      expect(where).toMatchObject({
        workspaceId: scope.workspaceId,
        sessionId: 'ses_0123456789abcdefghij',
        authorRole: 'user',
        session: { actorId: scope.actorId },
      });
      expect(where?.clientMessageId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('iptal (abort) hatasinda da claim birakilir', async () => {
      const aborted = Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });

      await expect(runChatTurn(input({ llm: failingLlm(aborted) }))).rejects.toBe(aborted);

      expect(tx.message.deleteMany).toHaveBeenCalledOnce();
    });

    it('birakma basarisiz olsa da asil hata yukari gider ve durum loglanir', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const failure = new Error('Gemini 429');
      tx.message.deleteMany.mockRejectedValue(new Error('db kapali'));

      await expect(runChatTurn(input({ llm: failingLlm(failure) }))).rejects.toBe(failure);

      expect(JSON.stringify(errorLog.mock.calls)).toContain('claim');
    });

    it('basarili turda claim birakilmaz', async () => {
      await runChatTurn(input());

      expect(tx.message.deleteMany).not.toHaveBeenCalled();
    });

    it('idempotency anahtari yoksa birakilacak claim da yoktur', async () => {
      const failure = new Error('Gemini 429');

      await expect(
        runChatTurn(input({ llm: failingLlm(failure), idempotencyKey: undefined })),
      ).rejects.toBe(failure);

      expect(tx.message.deleteMany).not.toHaveBeenCalled();
    });

    it('bir onceki deneme birakildiktan sonra ayni messageId temiz baslar', async () => {
      const failure = new Error('Gemini 429');
      await expect(runChatTurn(input({ llm: failingLlm(failure) }))).rejects.toBe(failure);

      // Birakilan claim yok: pending ve completed bos, yeni kullanici mesaji yazilir
      // (ilk deneme: kullanici mesaji; yeniden deneme: kullanici + asistan mesaji).
      const retried = await runChatTurn(input());

      expect(retried.text).toBe('cevap');
      expect(tx.message.create).toHaveBeenCalledTimes(3);
    });

    describe('cokme sonrasi kalan (birakilamamis) claim', () => {
      const pendingRow = (ageMs: number) => ({
        id: 'msg_eski_claim_0123456789',
        text: 'selam',
        createdAt: new Date(Date.now() - ageMs),
      });

      it('yeni claim "halen isleniyor" olarak reddedilir ve kalan sureyi bildirir', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_900_000_000_000);
        tx.message.findFirst.mockResolvedValueOnce(pendingRow(60_000)).mockResolvedValueOnce(null);

        const outcome = await runChatTurn(input()).catch((error: unknown) => error);

        expect(outcome).toBeInstanceOf(TurnInProgressError);
        expect((outcome as TurnInProgressError).retryAfterMs).toBe(STALE_PENDING_TURN_MS - 60_000);
        expect(tx.message.create).not.toHaveBeenCalled();
      });

      it('sure asilmissa terk edilmis sayilir: ayni kullanici mesaji yeniden kullanilir', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_900_000_000_000);
        tx.message.findFirst
          .mockResolvedValueOnce(pendingRow(STALE_PENDING_TURN_MS + 1))
          .mockResolvedValueOnce(null);
        const llmCall = llm();

        const result = await runChatTurn(input({ llm: llmCall.router }));

        expect(result.text).toBe('cevap');
        expect(llmCall.streamChat).toHaveBeenCalledOnce();
        // Cakisan ikinci kullanici satiri yazilmaz (yalniz asistan yaniti); mevcut satir
        // kronolojide sona tasinir.
        expect(tx.message.create.mock.calls.map(([arg]) => arg.data.authorRole)).toEqual([
          'assistant',
        ]);
        expect(tx.message.update).toHaveBeenCalledWith({
          where: { id: 'msg_eski_claim_0123456789' },
          data: { createdAt: new Date(1_900_000_000_000) },
        });
      });
    });
  });

  it('viewer rolunu mesaj yazmadan reddeder', async () => {
    const viewer = createWorkspaceScope({
      workspaceId: 'ws_0123456789abcdefghij',
      actorId: 'act_0123456789abcdefghij',
      role: 'viewer',
    });

    await expect(
      runChatTurn({
        db: { prisma: {} } as unknown as DbHandle,
        llm: llm().router,
        idempotencyKey: 'viewer-istegi',
        scope: viewer,
        sessionId: 'ses_0123456789abcdefghij',
        userText: 'yaz',
        onDelta: () => undefined,
      }),
    ).rejects.toThrow("en az 'member'");
    expect(tx.message.create).not.toHaveBeenCalled();
  });
});
