import { newActorId, newSessionId, newWorkspaceId, type DbHandle } from '@smith/db';
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  type ChatMessage,
  type LlmRouter,
  type StreamOptions,
} from '@smith/llm';
import { EMBED_TIMEOUT_MS, type Embedder } from '@smith/memory';
import { QueueName, parseQueuePayload } from '@smith/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleSessionSummary, SUMMARY_LLM_TIMEOUT_MS } from './session-summary.js';

/**
 * SESSION_SUMMARY tuketicisi: bosta kalan oturumu ozetleyip Memory'ye yazar.
 *
 * Prisma sahtelenir, `withScope` ve `upsertMemory` GERCEKTIR: sahte istemci
 * `$transaction`, `$executeRaw` (RLS degiskeni + Memory INSERT) ve iki okuma
 * sunar. Memory INSERT'inin sablon degerleri yakalanir, boylece sensitivity
 * ve sourceId'nin SQL'e GERCEKTEN gittigi test edilir.
 */

const workspaceId = newWorkspaceId();
const actorId = newActorId();

interface MemoryYazimi {
  sourceType: string;
  sourceId: string;
  content: string;
  sensitivity: string;
}

class SahteVeritabani {
  /** (sourceType + sourceId) → satir; `ON CONFLICT` davranisini taklit eder. */
  readonly hafiza = new Map<string, MemoryYazimi>();
  readonly rlsDegerleri: string[] = [];
  mesajlar: { authorRole: string; text: string }[] = [];
  mesajOkumaSayisi = 0;

  handle(): DbHandle {
    const tx = {
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
        if (strings.join('?').includes('INSERT INTO "Memory"')) {
          // Sablon: (id, workspaceId, sourceType, sourceId, content, vector, sensitivity)
          const [, , sourceType, sourceId, content, , sensitivity] = values as string[];
          this.hafiza.set(`${sourceType}|${sourceId}`, {
            sourceType: sourceType ?? '',
            sourceId: sourceId ?? '',
            content: content ?? '',
            sensitivity: sensitivity ?? '',
          });
        } else if (strings.join('?').includes('set_config')) {
          this.rlsDegerleri.push(String(values[1]));
        }
        return Promise.resolve(1);
      },
      message: {
        // Gercek DB `orderBy createdAt desc, id desc` ile EN YENI N satiri yeni->eski verir;
        // listSessionMessages bunu kronolojiye cevirir (packages/db/src/repos/messages.ts).
        findMany: (): Promise<unknown[]> => {
          this.mesajOkumaSayisi += 1;
          return Promise.resolve([...this.mesajlar].reverse());
        },
      },
      memory: {
        findFirst: (args: {
          where: { workspaceId: string; sourceType: string; sourceId: string };
        }): Promise<{ id: string } | null> => {
          const var_ = this.hafiza.has(`${args.where.sourceType}|${args.where.sourceId}`);
          return Promise.resolve(var_ ? { id: 'mem_var' } : null);
        },
      },
    };
    const prisma = {
      ...tx,
      $transaction: <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx),
    };
    return { prisma, pool: null, close: () => Promise.resolve() } as unknown as DbHandle;
  }
}

class SahteLlm {
  cagrilar: { role: string; messages: ChatMessage[]; signal: AbortSignal | undefined }[] = [];
  yanit = '- Kullanici sabah kahvesini sutsuz icer.';

  router(): LlmRouter {
    return {
      streamChat: (role: string, messages: ChatMessage[], options?: StreamOptions) => {
        this.cagrilar.push({ role, messages, signal: options?.signal });
        return Promise.resolve({ text: this.yanit });
      },
    } as unknown as LlmRouter;
  }
}

const embedder: Embedder = {
  model: 'sahte',
  embed: () => Promise.resolve([0.1, 0.2, 0.3]),
  embedBatch: (texts) => Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
};

function is(sessionId: string, minMessages = 4) {
  return parseQueuePayload(QueueName.SESSION_SUMMARY, {
    workspaceId,
    actorId,
    sessionId,
    minMessages,
    reason: 'live-bosta-kaldi',
  });
}

function konusma(adet: number): { authorRole: string; text: string }[] {
  return Array.from({ length: adet }, (_, i) => ({
    authorRole: i % 2 === 0 ? 'user' : 'assistant',
    text: `tur ${i}`,
  }));
}

describe('handleSessionSummary', () => {
  it('ozeti Memory’ye note olarak, sensitivity personal ile yazar', async () => {
    const db = new SahteVeritabani();
    db.mesajlar = konusma(6);
    const llm = new SahteLlm();
    const sessionId = newSessionId();

    await handleSessionSummary({ db: db.handle(), llm: llm.router(), embedder }, is(sessionId));

    expect(llm.cagrilar).toHaveLength(1);
    expect(llm.cagrilar[0]?.role).toBe('summarizer');
    expect([...db.hafiza.values()]).toEqual([
      {
        sourceType: 'note',
        sourceId: `summary:${sessionId}`,
        content: llm.yanit,
        sensitivity: 'personal',
      },
    ]);
    // Yazma payload'daki workspace'in RLS kapsami altinda yapildi.
    expect(db.rlsDegerleri.every((v) => v === workspaceId)).toBe(true);
  });

  it('transkript Kullanici/Smith etiketleriyle ozetleyiciye gider', async () => {
    const db = new SahteVeritabani();
    db.mesajlar = konusma(4);
    const llm = new SahteLlm();

    await handleSessionSummary(
      { db: db.handle(), llm: llm.router(), embedder },
      is(newSessionId()),
    );

    const transkript = llm.cagrilar[0]?.messages.at(-1)?.content;
    expect(transkript).toBe('Kullanici: tur 0\nSmith: tur 1\nKullanici: tur 2\nSmith: tur 3');
  });

  it('dislanan turlari ozetleyiciye gondermez, kalan baglami korur', async () => {
    vi.stubEnv('SMITH_CONTEXT_EXCLUDE', 'kw:acme');
    const db = new SahteVeritabani();
    db.mesajlar = [
      { authorRole: 'user', text: 'Globex urun karari' },
      { authorRole: 'assistant', text: 'kaydedildi' },
      { authorRole: 'user', text: 'Acme isveren notu' },
      { authorRole: 'assistant', text: 'Globex sonraki adim' },
    ];
    const llm = new SahteLlm();

    await handleSessionSummary(
      { db: db.handle(), llm: llm.router(), embedder },
      is(newSessionId(), 3),
    );

    const transcript = llm.cagrilar[0]?.messages.at(-1)?.content ?? '';
    expect(transcript).not.toContain('Acme');
    expect(transcript).toContain('Globex urun karari');
    vi.unstubAllEnvs();
  });

  it('dislanan model ozetini embed etmez ve yazmaz', async () => {
    vi.stubEnv('SMITH_CONTEXT_EXCLUDE', 'kw:acme');
    const db = new SahteVeritabani();
    db.mesajlar = konusma(4);
    const llm = new SahteLlm();
    llm.yanit = '- Acme bilgisi';
    const embed = vi.fn(() => Promise.resolve([0.1]));

    await handleSessionSummary(
      { db: db.handle(), llm: llm.router(), embedder: { model: 'sahte', embed } as never },
      is(newSessionId()),
    );

    expect(embed).not.toHaveBeenCalled();
    expect(db.hafiza.size).toBe(0);
    vi.unstubAllEnvs();
  });

  it('uzak ozetleyici ve embedder secret degerini hic gormez', async () => {
    const db = new SahteVeritabani();
    const secret = `sk-${'A'.repeat(40)}`;
    db.mesajlar = [
      { authorRole: 'user', text: `anahtarim ${secret}, tema koyu` },
      { authorRole: 'assistant', text: 'tamam' },
      { authorRole: 'user', text: 'parola=avci2' },
      { authorRole: 'assistant', text: 'not edildi' },
    ];
    const llm = new SahteLlm();
    llm.yanit = `- Tercih koyu. ${secret}`;
    const embedded: string[] = [];
    const recordingEmbedder: Embedder = {
      model: 'sahte',
      embed: (text) => {
        embedded.push(text);
        return Promise.resolve([0.1]);
      },
      embedBatch: () => Promise.resolve([]),
    };

    await handleSessionSummary(
      { db: db.handle(), llm: llm.router(), embedder: recordingEmbedder },
      is(newSessionId(), 3),
    );

    const remoteInput =
      llm.cagrilar[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(remoteInput).not.toContain(secret);
    expect(remoteInput).not.toContain('avci2');
    expect(remoteInput).toContain('[GIZLI]');
    expect(embedded.join('\n')).not.toContain(secret);
    expect([...db.hafiza.values()][0]?.content).not.toContain(secret);
  });

  it('IDEMPOTENT: ayni oturum icin ikinci is LLM’i cagirmaz ve ikinci kayit yazmaz', async () => {
    const db = new SahteVeritabani();
    db.mesajlar = konusma(6);
    const llm = new SahteLlm();
    const sessionId = newSessionId();
    const deps = { db: db.handle(), llm: llm.router(), embedder };

    await handleSessionSummary(deps, is(sessionId));
    llm.yanit = '- Baska bir ozet (yazilmamali).';
    await handleSessionSummary(deps, is(sessionId));

    expect(llm.cagrilar).toHaveLength(1);
    expect(db.hafiza.size).toBe(1);
    expect([...db.hafiza.values()][0]?.content).toBe('- Kullanici sabah kahvesini sutsuz icer.');
  });

  it('farkli oturumlar birbirinden bagimsiz ozetlenir', async () => {
    const db = new SahteVeritabani();
    db.mesajlar = konusma(6);
    const llm = new SahteLlm();
    const deps = { db: db.handle(), llm: llm.router(), embedder };

    await handleSessionSummary(deps, is(newSessionId()));
    await handleSessionSummary(deps, is(newSessionId()));

    expect(llm.cagrilar).toHaveLength(2);
    expect(db.hafiza.size).toBe(2);
  });

  it('minMessages altindaki oturumu ozetlemez', async () => {
    const db = new SahteVeritabani();
    db.mesajlar = konusma(3);
    const llm = new SahteLlm();

    await handleSessionSummary(
      { db: db.handle(), llm: llm.router(), embedder },
      is(newSessionId(), 4),
    );

    expect(llm.cagrilar).toHaveLength(0);
    expect(db.hafiza.size).toBe(0);
  });

  it('modelin bos ozetini basarili is saymaz', async () => {
    const db = new SahteVeritabani();
    db.mesajlar = konusma(6);
    const llm = new SahteLlm();
    llm.yanit = '   ';

    await expect(
      handleSessionSummary({ db: db.handle(), llm: llm.router(), embedder }, is(newSessionId())),
    ).rejects.toThrow(/bos/i);

    expect(db.hafiza.size).toBe(0);
  });

  it('actorId olmayan isi reddeder (kapsamsiz yazma yok)', async () => {
    const db = new SahteVeritabani();
    const llm = new SahteLlm();
    const payload = parseQueuePayload(QueueName.SESSION_SUMMARY, {
      workspaceId,
      sessionId: newSessionId(),
      reason: 'sistem-tetikli',
    });

    await expect(
      handleSessionSummary({ db: db.handle(), llm: llm.router(), embedder }, payload),
    ).rejects.toThrow('actorId');
    expect(db.hafiza.size).toBe(0);
  });
});

describe('handleSessionSummary zaman asimi', () => {
  afterEach(() => vi.restoreAllMocks());

  it('LLM ve embedding cagrilarina zaman asimi sinyali gecirir (asili uc kuyrugu kilitlemesin)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const db = new SahteVeritabani();
    db.mesajlar = konusma(6);
    const llm = new SahteLlm();
    const embedSignals: (AbortSignal | undefined)[] = [];
    const recordingEmbedder: Embedder = {
      model: 'sahte',
      embed: (_text, options) => {
        embedSignals.push(options?.signal);
        return Promise.resolve([0.1]);
      },
      embedBatch: () => Promise.resolve([]),
    };

    await handleSessionSummary(
      { db: db.handle(), llm: llm.router(), embedder: recordingEmbedder },
      is(newSessionId()),
    );

    const timeoutSignals = timeoutSpy.mock.results.map((result): unknown => result.value);
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, SUMMARY_LLM_TIMEOUT_MS);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, EMBED_TIMEOUT_MS);
    expect(llm.cagrilar[0]?.signal).toBe(timeoutSignals[0]);
    expect(embedSignals).toHaveLength(1);
    expect(embedSignals[0]).toBe(timeoutSignals[1]);
  });

  it('LLM tavani router tek deneme suresinden buyuk: yedek zinciri erken kesilmez', () => {
    expect(SUMMARY_LLM_TIMEOUT_MS).toBeGreaterThan(DEFAULT_ATTEMPT_TIMEOUT_MS);
  });
});
