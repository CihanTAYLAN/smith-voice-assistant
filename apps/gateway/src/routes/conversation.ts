import {
  appendMessage,
  createSession,
  newMessageId,
  withScope,
  type DbHandle,
  type Tx,
} from '@smith/db';
import { ForbiddenError, requireRole, type WorkspaceScope } from '@smith/tenancy';
import { Hono } from 'hono';
import { z } from 'zod';

import { scopeFromAuthHeader } from '../bearer.js';
import { SUMMARY_GRACE_MS, type SessionSummaryScheduler } from '../session-summary-scheduler.js';

/**
 * KONUSMA KALICILIGI (`/v1/tools/conversation/*`) — Live oturumunun (Gemini
 * speech-to-speech) konusmasini `Session` + `Message` tablolarina yazar ve
 * geri okur.
 *
 * NEDEN: Live modunda konusma tek bir WebSocket'te Google ile gerceklesir;
 * gateway'in sohbet turu (`/v1/ws` + `runChatTurn`) devrede DEGIL. Bu yuzden
 * sesli konusma HICBIR YERE yazilmiyordu — uygulama kapaninca konusma
 * tamamen kayboluyordu. Hafiza araclarinda (`tools.ts`) oldugu gibi cozum
 * ayni: masaustu (Rust) tarafi HTTP ile buraya yazar, tenancy ve RLS TEK
 * yerde kalir, `@smith/protocol` degismez.
 *
 * OTURUM SINIRI SUNUCUDA: istemci oturum kimligi TASIMAZ. "N saat
 * sessizlikten sonra yeni oturum" kurali burada uygulanir
 * (`SMITH_SESSION_IDLE_HOURS`, varsayilan 4). Gerekce: bosta kalma suresini
 * istemciye birakmak, iki istemcinin ayni konusma icin farkli karar vermesi
 * demektir — ayni anda hem masaustu hem CLI bagliyken oturum ikiye bolunur.
 *
 * GRUPLAMA ILE HATIRLAMA AYRI SEYLERDIR — bu ayrim bu dosyanin en kolay
 * yanlis yapilan yeri. Bosta kalma penceresi yalnizca `append`'i, yani
 * turlarin hangi `Session` altinda GRUPLANDIGINI ilgilendirir. `recent` bu
 * kurala TABI DEGILDIR: son turlari her zaman dondurur, gerekirse birden
 * fazla oturuma yayilarak. Aksi halde ozellik tam da var olma sebebinin
 * gerceklestigi anda — kullanici uygulamayi kapatip ertesi sabah actiginda —
 * bos donerdi. Kullanici icin "konusma" sureklidir; `Session` bizim
 * gruplama birimimizdir, onun hafizasinin siniri degil.
 *
 * UZUN VADELI HAFIZA: her yazilan tur, oturumun ozet isini bosta kalma
 * penceresi + pay kadar sonraya yeniden kurar (`session-summary-scheduler.ts`).
 * Konusma sustugunda worker oturumu ozetleyip Memory'ye yazar; yani acikca
 * 'kaydet' denmeyen bilgi de, son turlar penceresinin disinda, hatirlanir.
 *
 * Yetki: `Authorization: Bearer <access token>` — WS ve hafiza araclariyla
 * ayni token. Kapsam token'dan cikar (`actorId` istekten ASLA okunmaz), RLS
 * `withScope` ile uygulanir.
 */

/** Tek mesajda saklanan azami metin. Uzun metin kirpilir; hata degildir. */
const MAX_TEXT_CHARS = 4000;

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const DEFAULT_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 4000;

/** `SMITH_SESSION_IDLE_HOURS` verilmediginde gecerli bosta kalma penceresi. */
export const DEFAULT_IDLE_HOURS = 4;

/** Varsayilan yuzey: bu ucu bugun yalniz masaustu (Windows) istemcisi cagirir. */
const DEFAULT_SURFACE = 'windows';

const appendSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  surface: z.string().min(1).max(32).optional(),
  client_message_id: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

interface KeyedMessageRow {
  id: string;
  sessionId: string;
  createdAt: Date;
}

class ClientMessageIdConflictError extends Error {
  constructor() {
    super('client_message_id kullanilamiyor');
    this.name = 'ClientMessageIdConflictError';
  }
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  /** ISO 8601. */
  at: string;
  /**
   * Turun ait oldugu oturum. Turlar birden fazla oturuma yayilabildigi icin
   * her turda tasinir: modelin dunkü bir cumleyi az once soylenmis sanmasi,
   * bu ozelligin uretebilecegi en rahatsiz edici hata sinifidir.
   */
  sessionId: string;
}

export interface RecentConversation {
  /** Donen turlarin EN YENISININ oturumu. Hic mesaj yoksa null. */
  sessionId: string | null;
  /** ESKIDEN YENIYE (kronolojik) — model baglami bu sirayla okur. */
  turns: ConversationTurn[];
  /** true ise gecmisin tamami donmedi (limit veya karakter butcesi). */
  kesildi: boolean;
  /**
   * Donen turlar birden fazla oturuma yayiliyorsa true — yani arada bosta
   * kalma penceresini asan bir sessizlik var. Istemci bunu modele "arada bir
   * sure konusulmadi" diye cevirir; `at` damgalari da elindedir.
   */
  oturumDegisti: boolean;
}

/**
 * `SMITH_SESSION_IDLE_HOURS` cozumleyicisi. Gecersiz/eksik deger sessizce
 * varsayilana duser: yanlis bir env degeri yuzunden gateway acilmamasindansa,
 * kullaniciya gorunmez bir sekilde 4 saatlik pencereyle calismasi yeglenir.
 */
export function resolveIdleHours(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_IDLE_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IDLE_HOURS;
  return parsed;
}

export function createConversationRoutes(deps: {
  db: DbHandle;
  sessionSecret: string;
  /** Bosta kalma penceresi (saat). Verilmezse 4. */
  idleHours?: number;
  /** Bosta kalan oturumun ozet isini kuran zamanlayici. Verilmezse ozet kurulmaz. */
  summaryScheduler?: SessionSummaryScheduler;
}): Hono {
  const app = new Hono();
  const idleMs = (deps.idleHours ?? DEFAULT_IDLE_HOURS) * 60 * 60 * 1000;

  const scopeOf = (authHeader: string | undefined) =>
    scopeFromAuthHeader(deps.sessionSecret, authHeader);

  /** Kuyruk islemi suren oturumlar ve o sirada yeni tur alanlar; bkz. scheduleSummary. */
  const summaryInFlight = new Set<string>();
  const summaryDirty = new Map<string, WorkspaceScope>();

  /**
   * Ozet isini ARKA PLANDA kurar (await edilmez). Konusma turu bu noktada
   * ZATEN kalici yazildi; ozet isi kurulamasa da sesli konusmanin kaydi
   * dusmemeli. Yalniz reddedilen islemi yakalamak YETMEZ: kuyruk baglantisi
   * `maxRetriesPerRequest: null` ile acilir, yani Redis kapaliyken BullMQ
   * komutlari reddetmez, baglanti gelene kadar ASILI kalir. Handler bunu
   * beklese HTTP yaniti donmez, masaustundeki tek yazici thread'i (zaman asimsiz
   * ureq) takilir ve sonraki replikler kaybolurdu.
   *
   * Ayni oturum icin islem surerken gelen turlar yeni islem baslatmaz (Redis
   * uzun sure kapali kalirsa asili promise'ler birikmesin diye); oturumu
   * "kirli" isaretler. Surmekte olan islem bitince is bir kez daha kurulur,
   * boylece is son turdan itibaren gecikir: gec kalir, erken kosmaz. Hata
   * yutulmaz, gorunur loglanir; sonraki tur isi yeniden kurar.
   */
  const scheduleSummary = (sessionId: string, scope: WorkspaceScope): void => {
    if (!deps.summaryScheduler) return;
    if (summaryInFlight.has(sessionId)) {
      summaryDirty.set(sessionId, scope);
      return;
    }
    summaryInFlight.add(sessionId);
    void deps.summaryScheduler
      .schedule({ scope, sessionId, delayMs: idleMs + SUMMARY_GRACE_MS })
      .catch((error: unknown) => {
        console.warn(
          `[gateway] conversation/append: ozet isi kurulamadi (${sessionId}): ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        summaryInFlight.delete(sessionId);
        const dirtyScope = summaryDirty.get(sessionId);
        if (dirtyScope) {
          summaryDirty.delete(sessionId);
          scheduleSummary(sessionId, dirtyScope);
        }
      });
  };

  /** Bir konusma turunu kalici yaz. Oturumu sunucu secer. */
  app.post('/conversation/append', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = appendSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        {
          error:
            "role 'user' veya 'assistant' olmali, text zorunlu, client_message_id 8-64 karakter [A-Za-z0-9_-] olmali",
        },
        400,
      );
    }

    // Bos veya yalniz bosluktan olusan metin YAZILMAZ: sesli hatta VAD/ASR
    // bosluklari bos string olarak buraya dusebilir; bunlari saklamak
    // konusmayi bos turlarla kirletir ve butceyi bosa harcar.
    const trimmed = body.data.text.trim();
    if (trimmed.length === 0) return c.json({ error: 'text bos olamaz' }, 400);

    const text = trimmed.slice(0, MAX_TEXT_CHARS);
    if (text.length < trimmed.length) {
      console.warn(
        `[gateway] conversation/append: metin kirpildi (${trimmed.length} → ${MAX_TEXT_CHARS} karakter)`,
      );
    }

    try {
      const result = await withScope(deps.db.prisma, scope, async (tx) => {
        requireRole(scope, 'member');
        await lockActorSession(tx, scope);
        const clientMessageId = body.data.client_message_id;
        if (clientMessageId !== undefined) {
          // Lost response retry: yeni oturum secmeden once ilk kaydi dondur.
          const existing = await tx.message.findFirst({
            where: {
              workspaceId: scope.workspaceId,
              clientMessageId,
              session: { actorId: scope.actorId },
            },
            select: { id: true, sessionId: true, createdAt: true },
          });
          if (existing) {
            return {
              sessionId: existing.sessionId,
              messageId: existing.id,
              yeniOturum: await messageStartedSession(tx, scope, existing),
              created: false,
            };
          }
        }

        const active = await findActiveSession(tx, scope, idleMs, new Date());
        const session =
          active ??
          (await createSession(tx, scope, { surface: body.data.surface ?? DEFAULT_SURFACE }));
        if (clientMessageId === undefined) {
          const message = await appendMessage(tx, scope, {
            sessionId: session.id,
            authorRole: body.data.role,
            text,
          });
          return {
            sessionId: session.id,
            messageId: message.id,
            yeniOturum: active === null,
            created: false,
          };
        }

        const id = newMessageId();
        const message = await createKeyedMessage(tx, scope, {
          id,
          sessionId: session.id,
          authorRole: body.data.role,
          text,
          clientMessageId,
        });
        if (active === null && message.sessionId !== session.id) {
          // Iki ilk append ayni anda yeni oturum acabilir. Unique indeksin
          // kaybedeni bos kalan kendi oturumunu birakmasin.
          await tx.session.deleteMany({
            where: {
              id: session.id,
              workspaceId: scope.workspaceId,
              actorId: scope.actorId,
            },
          });
        }
        return {
          sessionId: message.sessionId,
          messageId: message.id,
          yeniOturum:
            message.id === id ? active === null : await messageStartedSession(tx, scope, message),
          created: message.id === id,
        };
      });
      scheduleSummary(result.sessionId, scope);
      const payload = {
        sessionId: result.sessionId,
        messageId: result.messageId,
        yeniOturum: result.yeniOturum,
      };
      return body.data.client_message_id === undefined
        ? c.json(payload)
        : c.json(payload, result.created ? 201 : 200);
    } catch (error) {
      // Yazma en az 'member' rolu ister; viewer temiz bir 403 gormeli, 500 degil.
      if (error instanceof ForbiddenError) return c.json({ error: error.message }, 403);
      if (error instanceof ClientMessageIdConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  /**
   * Son turlari dondurur — OTURUM SINIRINA BAKMADAN. Turlar birden fazla
   * oturuma yayilabilir; bu durumda `oturumDegisti` true olur ve her tur
   * kendi `sessionId`'sini tasir, boylece "arada uzun bir sessizlik vardi"
   * bilgisi kaybolmaz.
   */
  app.get('/conversation/recent', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const limit = clampQuery(c.req.query('limit'), DEFAULT_LIMIT, MAX_LIMIT);
    const maxChars = clampQuery(c.req.query('maxChars'), DEFAULT_MAX_CHARS, MAX_MAX_CHARS);

    const payload = await withScope(
      deps.db.prisma,
      scope,
      async (tx): Promise<RecentConversation> => {
        // Oturumlar arasi okuma: filtre `Message.workspaceId` (RLS'in birinci
        // katman kopyasi) + iliskili oturumun actor'u. Actor filtresi Message
        // uzerinde yok cunku sema onu Session'da tutuyor.
        // limit + 1: bir fazlasini istemek "daha var mi" sorusunu ekstra
        // COUNT sorgusu olmadan yanitlar.
        const rows = await tx.message.findMany({
          where: { workspaceId: scope.workspaceId, session: { actorId: scope.actorId } },
          // id ikincil anahtar: ayni milisaniyeye dusen iki satirda sira
          // kararli olsun diye (Postgres now() transaction basi zamanidir).
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          select: { sessionId: true, authorRole: true, text: true, createdAt: true },
        });
        const dahaVar = rows.length > limit;
        const pencere = rows.slice(0, limit);

        // Butce YENIDEN ESKIYE doldurulur: en yeni tur daima iceride kalir,
        // tasma en eskiden atilir. Sayim yalniz metin uzunlugu — rol etiketleri
        // butceye dahil degil (sozlesme).
        const kept: ConversationTurn[] = [];
        let used = 0;
        for (const row of pencere) {
          if (kept.length > 0 && used + row.text.length > maxChars) break;
          used += row.text.length;
          kept.push({
            role: row.authorRole === 'user' ? 'user' : 'assistant',
            text: row.text,
            at: row.createdAt.toISOString(),
            sessionId: row.sessionId,
          });
        }
        kept.reverse();

        return {
          sessionId: kept.at(-1)?.sessionId ?? null,
          turns: kept,
          kesildi: dahaVar || kept.length < pencere.length,
          oturumDegisti: new Set(kept.map((t) => t.sessionId)).size > 1,
        };
      },
    );

    return c.json(payload);
  });

  return app;
}

/** Unique indeks eszamanli insertleri ve kayip 201 yeniden denemelerini hakemler. */
async function createKeyedMessage(
  tx: Tx,
  scope: WorkspaceScope,
  data: {
    id: string;
    sessionId: string;
    authorRole: 'user' | 'assistant';
    text: string;
    clientMessageId: string;
  },
): Promise<KeyedMessageRow> {
  const [row] = await tx.$queryRaw<KeyedMessageRow[]>`
    INSERT INTO "Message" ("id", "workspaceId", "sessionId", "authorRole", "text", "clientMessageId")
    VALUES (${data.id}, ${scope.workspaceId}, ${data.sessionId}, ${data.authorRole}, ${data.text}, ${data.clientMessageId})
    ON CONFLICT ("workspaceId", "clientMessageId")
    DO UPDATE SET "clientMessageId" = EXCLUDED."clientMessageId"
    RETURNING "id", "sessionId", "createdAt"
  `;
  if (!row) throw new Error('Message INSERT RETURNING returned no row');
  return row;
}

/** Replay yanitinda `yeniOturum` degerini ilk yanitla ayni tutar. */
async function messageStartedSession(
  tx: Tx,
  scope: WorkspaceScope,
  message: KeyedMessageRow,
): Promise<boolean> {
  const session = await tx.session.findFirst({
    where: {
      id: message.sessionId,
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
    },
    select: { createdAt: true },
  });
  if (!session) throw new ClientMessageIdConflictError();
  return session.createdAt.getTime() === message.createdAt.getTime();
}

/** Ayni actor'un aktif oturum secimi ve olusturmasini transaction boyunca serilestirir. */
async function lockActorSession(tx: Tx, scope: WorkspaceScope): Promise<void> {
  const lockKey = `${scope.workspaceId}:${scope.actorId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

/**
 * Bu workspace + actor icin AKTIF oturum: en son oturumun en son mesaji
 * bosta kalma penceresi icindeyse o oturum, degilse null.
 *
 * Mesaji olmayan taze bir oturum (ornegin WS `hello` az once acmis olabilir)
 * oturumun kendi `createdAt`'ine gore degerlendirilir; aksi halde her sesli
 * tur bos oturumlarin yaninda yeni bir oturum daha acardi.
 *
 * NOT: sorgu repo katmani yerine burada duruyor — `@smith/db` repo'lari
 * "en son oturum" erisimi sunmuyor ve bu is icin paket sinirini asmadik.
 * where filtreleri RLS'in birinci katman kopyasidir (bkz. repos/sessions.ts).
 */
async function findActiveSession(
  tx: Tx,
  scope: WorkspaceScope,
  idleMs: number,
  now: Date,
): Promise<{ id: string } | null> {
  const latest = await tx.session.findFirst({
    where: { workspaceId: scope.workspaceId, actorId: scope.actorId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  });
  if (!latest) return null;

  const lastMessage = await tx.message.findFirst({
    where: { workspaceId: scope.workspaceId, sessionId: latest.id },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const lastAt = lastMessage?.createdAt ?? latest.createdAt;
  if (now.getTime() - lastAt.getTime() > idleMs) return null;
  return { id: latest.id };
}

/** Query parametresi → [1, max] araligina cekilmis tamsayi. Tavan asimi hata DEGIL. */
function clampQuery(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}
