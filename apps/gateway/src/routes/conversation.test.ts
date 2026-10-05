import { issueAccessToken } from '@smith/auth';
import { newActorId, newWorkspaceId, type DbHandle } from '@smith/db';
import { messageIdSchema, sessionIdSchema } from '@smith/protocol';
import { parseQueuePayload, QueueName } from '@smith/queue';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionSummaryScheduler,
  SUMMARY_GRACE_MS,
  SUMMARY_MIN_MESSAGES,
  summaryDeduplicationId,
} from '../session-summary-scheduler.js';
import { createConversationRoutes, resolveIdleHours } from './conversation.js';

/**
 * Konusma kaliciligi ucleri (`/v1/tools/conversation/*`).
 *
 * Prisma sahtelenir ama `withScope` GERCEKTIR: sahte istemci `$transaction`
 * ve `$executeRaw` sunar, boylece RLS oturum degiskeninin gercekten set
 * edildigi de test edilir. Repo katmani (createSession/appendMessage) ve
 * kimlik ureteci de gercektir — `msg_local_1` arizasinin (protokol regex'ini
 * ihlal eden elle yazilmis kimlik) tekrari boylece derleme degil TEST
 * seviyesinde yakalanir.
 *
 * Zaman `sleep` ile degil, satirlarin `createdAt` degerini geriye yazarak
 * kurulur; test suresi veri hacminden ve saatten bagimsizdir.
 */

const SECRET = 'test-secret-yalnizca-testte-kullanilir';
const SAAT_MS = 60 * 60 * 1000;

interface SessionRow {
  id: string;
  workspaceId: string;
  actorId: string;
  surface: string;
  createdAt: Date;
}

interface MessageRow {
  id: string;
  workspaceId: string;
  sessionId: string;
  authorRole: string;
  text: string;
  clientMessageId: string | null;
  createdAt: Date;
}

interface SiraKurali {
  createdAt?: 'asc' | 'desc';
  id?: 'asc' | 'desc';
}

/** Bellek-ici Prisma sahtesi: yalnizca bu rotalarin kullandigi cagrilar. */
class SahteVeritabani {
  readonly sessions: SessionRow[] = [];
  readonly messages: MessageRow[] = [];
  /** `withScope`'un set ettigi RLS degiskeni degerleri (kanit icin). */
  readonly rlsDegerleri: string[] = [];
  readonly rawQueries: string[] = [];
  activeSessionReadDelay = false;
  private readonly advisoryTails = new Map<string, Promise<void>>();

  acquireAdvisoryLock(key: string): Promise<() => void> {
    const previous = this.advisoryTails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = () => {
        resolve();
        if (this.advisoryTails.get(key) === current) this.advisoryTails.delete(key);
      };
    });
    this.advisoryTails.set(key, current);
    return previous.then(() => release);
  }

  /**
   * Monotonik saat: gercek hayatta her append AYRI transaction'dir ve ayri
   * `now()` alir. Sahtenin `new Date()` kullanmasi ayni milisaniyede
   * cakismalara ve testin kararsizlasmasina yol acardi. Sabit bir tarih de
   * kullanilamaz — rota gercek `Date.now()` ile karsilastirir, sabit gecmis
   * bir tarih her satiri "bayat" gosterirdi.
   */
  private saat = Date.now() - 5 * 60 * 1000;

  sonrakiZaman(): Date {
    this.saat += 1000;
    return new Date(this.saat);
  }

  /** Tum satirlari `saat` kadar geriye alir — bosta kalma testi icin. */
  geriyeAl(saat: number): void {
    for (const row of this.sessions)
      row.createdAt = new Date(row.createdAt.getTime() - saat * SAAT_MS);
    for (const row of this.messages)
      row.createdAt = new Date(row.createdAt.getTime() - saat * SAAT_MS);
  }
}

function sirala<T extends { createdAt: Date; id: string }>(
  rows: T[],
  orderBy: SiraKurali | SiraKurali[],
): T[] {
  const kurallar = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const kural of kurallar) {
      if (kural.createdAt) {
        const fark = a.createdAt.getTime() - b.createdAt.getTime();
        if (fark !== 0) return kural.createdAt === 'asc' ? fark : -fark;
      }
      if (kural.id) {
        const fark = a.id.localeCompare(b.id);
        if (fark !== 0) return kural.id === 'asc' ? fark : -fark;
      }
    }
    return 0;
  });
}

function sahteHandle(store: SahteVeritabani): DbHandle {
  const tx = {
    $executeRaw: (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      // withScope: SELECT set_config(<degisken>, <workspaceId>, true)
      store.rlsDegerleri.push(String(values[1]));
      return Promise.resolve(1);
    },
    session: {
      create: (args: { data: Omit<SessionRow, 'createdAt'> }): Promise<SessionRow> => {
        const row: SessionRow = { ...args.data, createdAt: store.sonrakiZaman() };
        store.sessions.push(row);
        return Promise.resolve(row);
      },
      findFirst: async (args: {
        where: { id?: string; workspaceId: string; actorId: string };
        orderBy?: SiraKurali | SiraKurali[];
      }): Promise<SessionRow | null> => {
        const eslesen = store.sessions.filter(
          (s) =>
            (args.where.id === undefined || s.id === args.where.id) &&
            s.workspaceId === args.where.workspaceId &&
            s.actorId === args.where.actorId,
        );
        if (store.activeSessionReadDelay && args.where.id === undefined) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return args.orderBy ? (sirala(eslesen, args.orderBy)[0] ?? null) : (eslesen[0] ?? null);
      },
      deleteMany: (args: {
        where: { id: string; workspaceId: string; actorId: string };
      }): Promise<{ count: number }> => {
        const index = store.sessions.findIndex(
          (session) =>
            session.id === args.where.id &&
            session.workspaceId === args.where.workspaceId &&
            session.actorId === args.where.actorId,
        );
        if (index === -1) return Promise.resolve({ count: 0 });
        store.sessions.splice(index, 1);
        return Promise.resolve({ count: 1 });
      },
    },
    message: {
      create: (args: {
        data: Omit<MessageRow, 'createdAt' | 'clientMessageId'> & {
          clientMessageId?: string | null;
          inputTokens: number | null;
        };
      }): Promise<MessageRow> => {
        const row: MessageRow = {
          id: args.data.id,
          workspaceId: args.data.workspaceId,
          sessionId: args.data.sessionId,
          authorRole: args.data.authorRole,
          text: args.data.text,
          clientMessageId: args.data.clientMessageId ?? null,
          createdAt: store.sonrakiZaman(),
        };
        store.messages.push(row);
        return Promise.resolve(row);
      },
      findFirst: (args: {
        where: {
          workspaceId: string;
          sessionId?: string;
          clientMessageId?: string;
          session?: { actorId: string };
        };
        orderBy?: SiraKurali | SiraKurali[];
      }): Promise<MessageRow | null> => {
        const eslesen = store.messages.filter((m) => {
          if (m.workspaceId !== args.where.workspaceId) return false;
          if (args.where.sessionId !== undefined && m.sessionId !== args.where.sessionId)
            return false;
          if (
            args.where.clientMessageId !== undefined &&
            m.clientMessageId !== args.where.clientMessageId
          )
            return false;
          if (args.where.session) {
            const session = store.sessions.find((candidate) => candidate.id === m.sessionId);
            if (session?.actorId !== args.where.session.actorId) return false;
          }
          return true;
        });
        return Promise.resolve(
          args.orderBy ? (sirala(eslesen, args.orderBy)[0] ?? null) : (eslesen[0] ?? null),
        );
      },
      /**
       * `recent` oturumlar arasi okur: filtre workspace + iliskili oturumun
       * actor'u. Sahte de gercek sorgu gibi Session'a bakarak eslestirir,
       * yoksa kiraci izolasyonu testi bir sey kanitlamazdi.
       */
      findMany: (args: {
        where: { workspaceId: string; session: { actorId: string } };
        orderBy: SiraKurali | SiraKurali[];
        take: number;
      }): Promise<MessageRow[]> => {
        const eslesen = store.messages.filter((m) => {
          if (m.workspaceId !== args.where.workspaceId) return false;
          const oturum = store.sessions.find((s) => s.id === m.sessionId);
          return oturum?.actorId === args.where.session.actorId;
        });
        return Promise.resolve(sirala(eslesen, args.orderBy).slice(0, args.take));
      },
    },
    $queryRaw: <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      store.rawQueries.push(strings.join('?'));
      const [id, scopedWorkspaceId, sessionId, authorRole, text, clientMessageId] =
        values.map(String);
      const existing = store.messages.find(
        (message) =>
          message.workspaceId === scopedWorkspaceId && message.clientMessageId === clientMessageId,
      );
      if (existing) return Promise.resolve([existing] as T);

      const session = store.sessions.find((candidate) => candidate.id === sessionId);
      const row: MessageRow = {
        id: id ?? '',
        workspaceId: scopedWorkspaceId ?? '',
        sessionId: sessionId ?? '',
        authorRole: authorRole ?? '',
        text: text ?? '',
        clientMessageId: clientMessageId ?? null,
        // PostgreSQL CURRENT_TIMESTAMP is transaction-scoped. A session and
        // its first message created by one append therefore share this value.
        createdAt:
          session && !store.messages.some((message) => message.sessionId === sessionId)
            ? session.createdAt
            : store.sonrakiZaman(),
      };
      store.messages.push(row);
      return Promise.resolve([row] as T);
    },
  };

  const prisma = {
    ...tx,
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      let releaseAdvisory: (() => void) | undefined;
      const localTx = {
        ...tx,
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join('?');
          store.rawQueries.push(query);
          if (query.includes('pg_advisory_xact_lock')) {
            releaseAdvisory = await store.acquireAdvisoryLock(String(values[0]));
            return 1;
          }
          store.rlsDegerleri.push(String(values[1]));
          return 1;
        },
      };
      try {
        return await fn(localTx);
      } finally {
        releaseAdvisory?.();
      }
    },
  };

  return { prisma, pool: null, close: () => Promise.resolve() } as unknown as DbHandle;
}

interface EklemeYaniti {
  sessionId: string;
  messageId: string;
  yeniOturum: boolean;
}

interface GecmisYaniti {
  sessionId: string | null;
  turns: { role: string; text: string; at: string; sessionId: string }[];
  kesildi: boolean;
  oturumDegisti: boolean;
}

let store: SahteVeritabani;
let app: Hono;
let token: string;
let ikinciToken: string;
let ayniWorkspaceDigerActorToken: string;

const workspaceId = newWorkspaceId();
const actorId = newActorId();
const ikinciWorkspaceId = newWorkspaceId();
const ikinciActorId = newActorId();

beforeEach(() => {
  store = new SahteVeritabani();
  app = new Hono();
  // Gercek montaj noktasiyla ayni: /v1/tools altinda.
  app.route(
    '/v1/tools',
    createConversationRoutes({ db: sahteHandle(store), sessionSecret: SECRET, idleHours: 4 }),
  );
  token = issueAccessToken(SECRET, { workspaceId, actorId, role: 'owner' });
  ikinciToken = issueAccessToken(SECRET, {
    workspaceId: ikinciWorkspaceId,
    actorId: ikinciActorId,
    role: 'owner',
  });
  ayniWorkspaceDigerActorToken = issueAccessToken(SECRET, {
    workspaceId,
    actorId: ikinciActorId,
    role: 'owner',
  });
});

async function ekle(govde: Record<string, unknown>, yetki: string = token): Promise<Response> {
  return app.request('/v1/tools/conversation/append', {
    method: 'POST',
    headers: { authorization: `Bearer ${yetki}`, 'content-type': 'application/json' },
    body: JSON.stringify(govde),
  });
}

async function gecmis(sorgu = '', yetki: string = token): Promise<Response> {
  return app.request(`/v1/tools/conversation/recent${sorgu}`, {
    headers: { authorization: `Bearer ${yetki}` },
  });
}

describe('POST /v1/tools/conversation/append', () => {
  it('token yoksa 401 doner ve hicbir sey yazmaz', async () => {
    const res = await app.request('/v1/tools/conversation/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'user', text: 'merhaba' }),
    });
    expect(res.status).toBe(401);
    expect(store.messages).toHaveLength(0);
  });

  it('bos ve yalniz bosluk iceren metni 400 ile reddeder, DB’ye yazmaz', async () => {
    for (const text of ['', '   ', '\n\t  ']) {
      const res = await ekle({ role: 'user', text });
      expect(res.status).toBe(400);
    }
    expect(store.messages).toHaveLength(0);
    expect(store.sessions).toHaveLength(0);
  });

  it('gecersiz role 400 doner', async () => {
    const res = await ekle({ role: 'system', text: 'merhaba' });
    expect(res.status).toBe(400);
    expect(store.messages).toHaveLength(0);
  });

  it('ilk cagri yeni oturum acar, hemen ardindaki cagri ayni oturumu kullanir', async () => {
    const ilk = (await (await ekle({ role: 'user', text: 'selam Smith' })).json()) as EklemeYaniti;
    expect(ilk.yeniOturum).toBe(true);

    const ikinci = (await (
      await ekle({ role: 'assistant', text: 'buyurun efendim' })
    ).json()) as EklemeYaniti;
    expect(ikinci.yeniOturum).toBe(false);
    expect(ikinci.sessionId).toBe(ilk.sessionId);
    expect(store.sessions).toHaveLength(1);
    expect(store.messages).toHaveLength(2);
  });

  it('ayni client_message_id ile ardisik yeniden denemede ilk mesaji dondurur', async () => {
    const ilk = await ekle({
      role: 'user',
      text: 'ilk metin',
      client_message_id: 'desktop-turn-123',
    });
    const tekrar = await ekle({
      role: 'user',
      text: 'degistirilmis metin',
      client_message_id: 'desktop-turn-123',
    });

    expect([ilk.status, tekrar.status]).toEqual([201, 200]);
    expect(await tekrar.json()).toEqual(await ilk.json());
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]?.text).toBe('ilk metin');
  });

  it('ayni client_message_id ile eszamanli yeniden denemede tek mesaj olusturur', async () => {
    const body = {
      role: 'assistant',
      text: 'tek cevap',
      client_message_id: 'desktop-turn-456',
    };
    const responses = await Promise.all([ekle(body), ekle(body)]);
    const payloads = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(payloads[1]).toEqual(payloads[0]);
    expect(store.messages).toHaveLength(1);
    expect(store.sessions).toHaveLength(1);
    expect(
      store.rawQueries.some((query) =>
        /ON CONFLICT \("workspaceId", "clientMessageId"\)/.test(query),
      ),
    ).toBe(true);
  });

  it('client_message_id yoksa bugunku keyless davranisi korur', async () => {
    const ilk = await ekle({ role: 'user', text: 'ayni metin' });
    const ikinci = await ekle({ role: 'user', text: 'ayni metin' });

    expect([ilk.status, ikinci.status]).toEqual([200, 200]);
    expect(store.messages).toHaveLength(2);
    expect((await ilk.json()) as EklemeYaniti).not.toEqual((await ikinci.json()) as EklemeYaniti);
  });

  it.each(['short', 'x'.repeat(65), 'bosluk var', 'turkce-ç', 'emoji-😀', 1, null])(
    'gecersiz client_message_id degerini reddeder (%#)',
    async (clientMessageId) => {
      const res = await ekle({
        role: 'user',
        text: 'gecersiz kimlik',
        client_message_id: clientMessageId,
      });
      expect(res.status).toBe(400);
      expect(store.messages).toHaveLength(0);
    },
  );

  it('8 ve 64 karakterlik client_message_id sinirlarini kabul eder', async () => {
    const enKisa = await ekle({
      role: 'user',
      text: 'kisa sinir',
      client_message_id: 'abcd_123',
    });
    const enUzun = await ekle({
      role: 'assistant',
      text: 'uzun sinir',
      client_message_id: `A-${'x'.repeat(62)}`,
    });

    expect([enKisa.status, enUzun.status]).toEqual([201, 201]);
    expect(store.messages).toHaveLength(2);
  });

  it('ayni client_message_id baska workspace ile catismaz', async () => {
    const body = { role: 'user', text: 'ortak kimlik', client_message_id: 'shared-id-123' };
    const benim = await ekle(body);
    const digerinin = await ekle(body, ikinciToken);

    expect([benim.status, digerinin.status]).toEqual([201, 201]);
    expect(store.messages).toHaveLength(2);
    expect(((await benim.json()) as EklemeYaniti).messageId).not.toBe(
      ((await digerinin.json()) as EklemeYaniti).messageId,
    );
  });

  it('ayni workspace baska actor client_message_id cakismasini 409 yapar', async () => {
    const body = { role: 'user', text: 'ilk actor', client_message_id: 'shared-actor-id' };
    const [ilk, digeri] = await Promise.all([
      ekle(body),
      ekle({ ...body, text: 'ikinci actor gizli metni' }, ayniWorkspaceDigerActorToken),
    ]);

    expect([ilk.status, digeri.status].sort()).toEqual([201, 409]);
    expect(store.messages).toHaveLength(1);
    const conflict = ilk.status === 409 ? ilk : digeri;
    const conflictBody = (await conflict.json()) as Record<string, unknown>;
    expect(conflictBody).toEqual({ error: 'client_message_id kullanilamiyor' });
    expect(JSON.stringify(conflictBody)).not.toContain('ikinci actor gizli metni');
  });

  it('ayni actor farkli eszamanli mesajlarda tek aktif oturum acar', async () => {
    store.activeSessionReadDelay = true;
    const responses = await Promise.all([
      ekle({ role: 'user', text: 'bir', client_message_id: 'parallel-msg-1' }),
      ekle({ role: 'user', text: 'iki', client_message_id: 'parallel-msg-2' }),
    ]);
    const payloads = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      sessionId: string;
      yeniOturum: boolean;
    }>;

    expect(new Set(payloads.map((payload) => payload.sessionId)).size).toBe(1);
    expect(payloads.filter((payload) => payload.yeniOturum)).toHaveLength(1);
    expect(store.sessions).toHaveLength(1);
    expect(store.rawQueries.some((query) => query.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('migration workspace kapsamli unique indeksi ve tersine alma yolunu tasir', () => {
    const migration = new URL(
      '../../../../packages/db/prisma/migrations/20261003030000_add_message_client_idempotency/',
      import.meta.url,
    );
    const up = readFileSync(new URL('migration.sql', migration), 'utf8');
    expect(up).toContain('ALTER TABLE "Message" ADD COLUMN "clientMessageId" VARCHAR(64)');
    expect(up).toContain(
      'CREATE UNIQUE INDEX "Message_workspaceId_clientMessageId_key" ON "Message"("workspaceId", "clientMessageId")',
    );
    expect(up).not.toContain('CREATE POLICY');

    const down = readFileSync(new URL('down.sql', migration), 'utf8');
    expect(down).toMatch(
      /BEGIN;[\s\S]*DROP INDEX "Message_workspaceId_clientMessageId_key";[\s\S]*ALTER TABLE "Message" DROP COLUMN "clientMessageId";[\s\S]*COMMIT;/,
    );
  });

  it('urettigi kimlikler protokol regex’lerine uyar', async () => {
    // GERCEK ARIZA: elle yazilmis `msg_local_1` protokol regex'ini ihlal edip
    // her istegi reddettirmisti. Kimlik ureteci depo yardimcisidir; bu test
    // birinin yeniden elle kimlik uretmesini yakalar.
    const body = (await (
      await ekle({ role: 'user', text: 'kimlik testi' })
    ).json()) as EklemeYaniti;
    expect(sessionIdSchema.safeParse(body.sessionId).success).toBe(true);
    expect(messageIdSchema.safeParse(body.messageId).success).toBe(true);
  });

  it('4000 karakterden uzun metni kirpar (hata degil)', async () => {
    const res = await ekle({ role: 'user', text: 'a'.repeat(4500) });
    expect(res.status).toBe(200);
    expect(store.messages[0]?.text).toHaveLength(4000);
  });

  it('bosta kalma penceresi asilmissa yeni oturum acar', async () => {
    const ilk = (await (await ekle({ role: 'user', text: 'ilk konusma' })).json()) as EklemeYaniti;

    // Zamani sleep ile degil, satirlari geriye alarak kur: 5 saat > 4 saat.
    store.geriyeAl(5);

    const sonraki = (await (await ekle({ role: 'user', text: 'yeni gun' })).json()) as EklemeYaniti;
    expect(sonraki.yeniOturum).toBe(true);
    expect(sonraki.sessionId).not.toBe(ilk.sessionId);
    expect(store.sessions).toHaveLength(2);
  });

  it('pencere icinde kalan sessizlik oturumu bolmez', async () => {
    const ilk = (await (await ekle({ role: 'user', text: 'ilk konusma' })).json()) as EklemeYaniti;
    store.geriyeAl(3);
    const sonraki = (await (await ekle({ role: 'user', text: 'devam' })).json()) as EklemeYaniti;
    expect(sonraki.yeniOturum).toBe(false);
    expect(sonraki.sessionId).toBe(ilk.sessionId);
  });

  it('RLS oturum degiskenini istegin workspace’i ile set eder', async () => {
    await ekle({ role: 'user', text: 'kapsam kaniti' });
    expect(store.rlsDegerleri).toContain(workspaceId);
    expect(store.rlsDegerleri.every((v) => v === workspaceId)).toBe(true);
  });
});

describe('GET /v1/tools/conversation/recent', () => {
  it('hic konusma yoksa bos doner', async () => {
    const body = (await (await gecmis()).json()) as GecmisYaniti;
    expect(body).toEqual({ sessionId: null, turns: [], kesildi: false, oturumDegisti: false });
  });

  it('turlari ESKIDEN YENIYE dondurur', async () => {
    await ekle({ role: 'user', text: 'bir' });
    await ekle({ role: 'assistant', text: 'iki' });
    await ekle({ role: 'user', text: 'uc' });

    const body = (await (await gecmis()).json()) as GecmisYaniti;
    expect(body.turns.map((t) => t.text)).toEqual(['bir', 'iki', 'uc']);
    expect(body.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.kesildi).toBe(false);
    expect(new Date(body.turns[0]?.at ?? '').getTime()).toBeLessThan(
      new Date(body.turns[2]?.at ?? '').getTime(),
    );
  });

  it('maxChars asilinca EN ESKI turlari atar, en yeniyi daima tutar', async () => {
    await ekle({ role: 'user', text: 'a'.repeat(60) });
    await ekle({ role: 'assistant', text: 'b'.repeat(60) });
    await ekle({ role: 'user', text: 'c'.repeat(60) });
    await ekle({ role: 'assistant', text: 'SON-TUR' });

    const body = (await (await gecmis('?maxChars=130')).json()) as GecmisYaniti;
    expect(body.kesildi).toBe(true);
    // 7 + 60 + 60 = 127 <= 130; bir tane daha eklemek 187 yapardi.
    expect(body.turns.map((t) => t.text[0])).toEqual(['b', 'c', 'S']);
    expect(body.turns.at(-1)?.text).toBe('SON-TUR');
    expect(body.turns.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(130);
  });

  it('butceye sigmayan tek turu yine de dondurur', async () => {
    await ekle({ role: 'user', text: 'x'.repeat(500) });
    const body = (await (await gecmis('?maxChars=100')).json()) as GecmisYaniti;
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0]?.text).toHaveLength(500);
    // Atilan tur yok: kesilme yasanmadi.
    expect(body.kesildi).toBe(false);
  });

  it('limit tavani 50, maxChars tavani 4000 olarak uygulanir (hata degil)', async () => {
    for (let i = 0; i < 60; i += 1) {
      await ekle({ role: i % 2 === 0 ? 'user' : 'assistant', text: `tur-${i}` });
    }
    const body = (await (await gecmis('?limit=999&maxChars=99999')).json()) as GecmisYaniti;
    expect(body.turns).toHaveLength(50);
    expect(body.turns.at(-1)?.text).toBe('tur-59');
    expect(body.kesildi).toBe(true);

    const uzun = new SahteVeritabani();
    store = uzun;
    app = new Hono();
    app.route(
      '/v1/tools',
      createConversationRoutes({ db: sahteHandle(uzun), sessionSecret: SECRET, idleHours: 4 }),
    );
    for (let i = 0; i < 10; i += 1) await ekle({ role: 'user', text: 'z'.repeat(600) });
    const buyuk = (await (await gecmis('?maxChars=99999')).json()) as GecmisYaniti;
    expect(buyuk.turns.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(4000);
    expect(buyuk.kesildi).toBe(true);
  });

  it('limit kadar tur doner ve fazlasi varsa kesildi bildirir', async () => {
    for (let i = 0; i < 5; i += 1) await ekle({ role: 'user', text: `t${i}` });
    const body = (await (await gecmis('?limit=2')).json()) as GecmisYaniti;
    expect(body.turns.map((t) => t.text)).toEqual(['t3', 't4']);
    expect(body.kesildi).toBe(true);
  });

  it('bosta kalma penceresi asilmis olsa bile son turlari DONDURUR', async () => {
    // OZELLIGIN VAR OLMA SEBEBI: kullanici uygulamayi kapatip ertesi sabah
    // aciyor. Bosta kalma penceresi bir GRUPLAMA kuralidir (append'i
    // ilgilendirir), hatirlama kurali DEGIL. Bu test daha once tam tersini —
    // yani ozelligin en tipik anda bos donmesini — korumaktaydi.
    const dun = (await (
      await ekle({ role: 'user', text: 'dun aksam konustuk' })
    ).json()) as EklemeYaniti;
    store.geriyeAl(8);

    const body = (await (await gecmis()).json()) as GecmisYaniti;
    expect(body.turns.map((t) => t.text)).toEqual(['dun aksam konustuk']);
    expect(body.sessionId).toBe(dun.sessionId);
    expect(body.oturumDegisti).toBe(false);
  });

  it('turlar birden fazla oturuma yayilabilir ve oturum degisimi veride gorunur', async () => {
    const dun = (await (await ekle({ role: 'user', text: 'dun aksam' })).json()) as EklemeYaniti;
    store.geriyeAl(8); // pencere asildi → sonraki append yeni oturum acar
    const bugun = (await (await ekle({ role: 'user', text: 'gunaydin' })).json()) as EklemeYaniti;
    expect(bugun.yeniOturum).toBe(true);

    const body = (await (await gecmis()).json()) as GecmisYaniti;
    // Kullanici icin konusma sureklidir: iki oturum tek akista, kronolojik.
    expect(body.turns.map((t) => t.text)).toEqual(['dun aksam', 'gunaydin']);
    expect(body.turns.map((t) => t.sessionId)).toEqual([dun.sessionId, bugun.sessionId]);
    // Bilgi kaybolmuyor: model dunkü cumleyi az once soylenmis sanmasin.
    expect(body.oturumDegisti).toBe(true);
    expect(body.sessionId).toBe(bugun.sessionId);
  });
});

describe('kiraci siniri', () => {
  it('baska bir workspace’in mesajlarini ASLA dondurmez', async () => {
    const benim = (await (
      await ekle({ role: 'user', text: 'gizli notum' })
    ).json()) as EklemeYaniti;

    // Ikinci kiraci ayni sahte veritabanini paylasiyor; izolasyon yalniz
    // kapsam filtresinden gelmeli.
    const digeri = (await (
      await ekle({ role: 'user', text: 'baska kiraci' }, ikinciToken)
    ).json()) as EklemeYaniti;
    expect(digeri.yeniOturum).toBe(true);
    expect(digeri.sessionId).not.toBe(benim.sessionId);

    const digerininGecmisi = (await (await gecmis('', ikinciToken)).json()) as GecmisYaniti;
    expect(digerininGecmisi.turns.map((t) => t.text)).toEqual(['baska kiraci']);

    const benimGecmisim = (await (await gecmis()).json()) as GecmisYaniti;
    expect(benimGecmisim.turns.map((t) => t.text)).toEqual(['gizli notum']);
    expect(store.rlsDegerleri).toContain(ikinciWorkspaceId);
  });
});

describe('resolveIdleHours', () => {
  it('gecersiz veya eksik degerde 4 saate duser', () => {
    expect(resolveIdleHours(undefined)).toBe(4);
    expect(resolveIdleHours('')).toBe(4);
    expect(resolveIdleHours('abc')).toBe(4);
    expect(resolveIdleHours('0')).toBe(4);
    expect(resolveIdleHours('-3')).toBe(4);
  });

  it('gecerli degeri kullanir', () => {
    expect(resolveIdleHours('8')).toBe(8);
    expect(resolveIdleHours('0.5')).toBe(0.5);
  });
});

/**
 * BullMQ deduplication davranisini (`replace`) taklit eder: ayni deduplication
 * kimligiyle gelen `add`, bekleyen isi yenisiyle degistirir. Gercek Redis'e
 * dokunulmaz; sozlesme node_modules/bullmq kaynagindan dogrulandi.
 */
class SahteKuyruk {
  readonly isler = new Map<string, { name: string; data: unknown; delay: number | undefined }>();
  hataFirlat = false;
  /** Redis kapali + maxRetriesPerRequest:null: komutlar reddedilmez, hic cozulmez. */
  asili = false;
  asiliCagri = 0;

  add(
    name: string,
    data: unknown,
    opts: { delay?: number; deduplication: { id: string; replace: boolean } },
  ): Promise<undefined> {
    if (this.asili) {
      this.asiliCagri += 1;
      return new Promise(() => undefined);
    }
    if (this.hataFirlat) return Promise.reject(new Error('redis kapali'));
    if (!this.isler.has(opts.deduplication.id) || opts.deduplication.replace) {
      this.isler.set(opts.deduplication.id, { name, data, delay: opts.delay });
    }
    return Promise.resolve(undefined);
  }
}

/** Arka planda kurulan ozet isinin (cozulmus sahte promise zinciri) bitmesini bekler. */
const arkaPlanBitsin = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Live konusma ozeti zamanlama', () => {
  let kuyruk: SahteKuyruk;

  beforeEach(() => {
    kuyruk = new SahteKuyruk();
    app = new Hono();
    app.route(
      '/v1/tools',
      createConversationRoutes({
        db: sahteHandle(store),
        sessionSecret: SECRET,
        idleHours: 4,
        summaryScheduler: createSessionSummaryScheduler(kuyruk as never),
      }),
    );
  });

  it('konusma turu oturum icin TEK ozet isi kurar (bosta kalma + pay kadar gecikmeli)', async () => {
    const yanit = (await (await ekle({ role: 'user', text: 'selam' })).json()) as EklemeYaniti;
    await arkaPlanBitsin();

    expect([...kuyruk.isler.keys()]).toEqual([summaryDeduplicationId(yanit.sessionId)]);
    const is = kuyruk.isler.get(summaryDeduplicationId(yanit.sessionId));
    expect(is?.delay).toBe(4 * SAAT_MS + SUMMARY_GRACE_MS);

    // Payload kuyruk sozlesmesine uyar ve kapsami token'dan gelir.
    const payload = parseQueuePayload(QueueName.SESSION_SUMMARY, is?.data);
    expect(payload).toMatchObject({
      workspaceId,
      actorId,
      sessionId: yanit.sessionId,
      minMessages: SUMMARY_MIN_MESSAGES,
    });
  });

  it('ayni oturuma gelen sonraki turlar ikinci is URETMEZ, mevcut isi tazeler', async () => {
    const ilk = (await (await ekle({ role: 'user', text: 'bir' })).json()) as EklemeYaniti;
    await arkaPlanBitsin();
    await arkaPlanBitsin();
    await ekle({ role: 'assistant', text: 'iki' });
    await arkaPlanBitsin();
    await ekle({ role: 'user', text: 'uc' });
    await arkaPlanBitsin();

    expect(kuyruk.isler.size).toBe(1);
    expect(kuyruk.isler.has(summaryDeduplicationId(ilk.sessionId))).toBe(true);
  });

  it('bosta kalan oturumun isi korunur, yeni oturum kendi isini alir', async () => {
    const dun = (await (await ekle({ role: 'user', text: 'dun' })).json()) as EklemeYaniti;
    await arkaPlanBitsin();
    store.geriyeAl(5); // pencere asildi

    const bugun = (await (await ekle({ role: 'user', text: 'bugun' })).json()) as EklemeYaniti;
    await arkaPlanBitsin();
    expect(bugun.sessionId).not.toBe(dun.sessionId);

    expect([...kuyruk.isler.keys()].sort()).toEqual(
      [summaryDeduplicationId(dun.sessionId), summaryDeduplicationId(bugun.sessionId)].sort(),
    );
  });

  it('reddedilen istek (400/401) is kurmaz', async () => {
    await ekle({ role: 'user', text: '   ' });
    await ekle({ role: 'system', text: 'x' });
    const yetkisiz = await app.request('/v1/tools/conversation/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'user', text: 'merhaba' }),
    });
    expect(yetkisiz.status).toBe(401);
    await arkaPlanBitsin();
    expect(kuyruk.isler.size).toBe(0);
  });

  it('kuyruk (Redis) hatasi konusma kaydini DUSURMEZ', async () => {
    kuyruk.hataFirlat = true;
    const res = await ekle({ role: 'user', text: 'redis kapaliyken konusuyorum' });

    expect(res.status).toBe(200);
    await arkaPlanBitsin();
    expect(store.messages.map((m) => m.text)).toEqual(['redis kapaliyken konusuyorum']);
  });

  it('kuyruk ASILIRSA (Redis kapali, istek reddedilmez) HTTP yaniti yine doner', async () => {
    kuyruk.asili = true;
    // Eski davranista handler asili promise'i bekler ve bu istek hic donmezdi.
    const res = await Promise.race([
      ekle({ role: 'user', text: 'redis asiliyken konusuyorum' }),
      new Promise<'zaman-asimi'>((resolve) => setTimeout(() => resolve('zaman-asimi'), 2000)),
    ]);

    expect(res).not.toBe('zaman-asimi');
    expect((res as Response).status).toBe(200);
    expect(store.messages.map((m) => m.text)).toEqual(['redis asiliyken konusuyorum']);
  });

  it('asili kuyrukta ayni oturumun sonraki turlari yeni kuyruk islemi BIRIKTIRMAZ', async () => {
    kuyruk.asili = true;
    await ekle({ role: 'user', text: 'bir' });
    await ekle({ role: 'assistant', text: 'iki' });
    await ekle({ role: 'user', text: 'uc' });
    await arkaPlanBitsin();

    expect(kuyruk.asiliCagri).toBe(1); // yalniz ilk add; digerleri atlandi
    expect(store.messages).toHaveLength(3);
  });

  it('in-flight sirasinda gelen turu dirty olarak isaretleyip bitince yeniden kurar', async () => {
    let ilkCoz: (() => void) | undefined;
    const schedule = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            ilkCoz = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    app = new Hono();
    app.route(
      '/v1/tools',
      createConversationRoutes({
        db: sahteHandle(store),
        sessionSecret: SECRET,
        idleHours: 4,
        summaryScheduler: { schedule },
      }),
    );

    await ekle({ role: 'user', text: 'bir' });
    await arkaPlanBitsin();
    await ekle({ role: 'assistant', text: 'iki' });
    expect(schedule).toHaveBeenCalledTimes(1);

    ilkCoz?.();
    await arkaPlanBitsin();
    await arkaPlanBitsin();
    expect(schedule).toHaveBeenCalledTimes(2);
  });
});
