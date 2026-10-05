import { createHash } from 'node:crypto';
import {
  appendMessage,
  newMessageId,
  withScope,
  type DbHandle,
  type MessageRecord,
  type Tx,
} from '@smith/db';
import type { ChatMessage, LlmRouter } from '@smith/llm';
import {
  buildRecallBlock,
  EMBED_TIMEOUT_MS,
  redactSecrets,
  searchMemories,
  type Embedder,
} from '@smith/memory';
import { ForbiddenError, requireRole, type WorkspaceScope } from '@smith/tenancy';

/** Bir mesaji asenkron indekslemek icin dar sozlesme; gateway kuyruga baglar. */
export type IndexMessageFn = (input: { sourceId: string }) => Promise<void>;

const TURN_HISTORY_LIMIT = 50;

/**
 * Bir turun makul ust siniri (recall + LLM zinciri + arac adimlari). Kullanici
 * mesaji bu sureden eski ve yaniti yoksa onu isleyen kimse kalmamistir (surec
 * coktu): claim terk edilmis sayilir ve yeniden kullanilir. Normal basarisizlik,
 * iptal ve baglanti kopmasinda claim beklemeden birakilir (`releaseTurnClaim`).
 */
export const STALE_PENDING_TURN_MS = 10 * 60_000;

export class TurnInProgressError extends Error {
  /** Claim terk edilmis sayilana kadar kalan sure (ms). */
  constructor(readonly retryAfterMs: number) {
    super('Bu idempotent tur halen isleniyor.');
    this.name = 'TurnInProgressError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency anahtari farkli bir prompt icin kullanilmis.');
    this.name = 'IdempotencyConflictError';
  }
}

export interface PreparedTurn {
  assistantClientMessageId?: string;
  history?: MessageRecord[];
  replay?: TurnResult;
  userMessageId?: string;
}

function turnRecordKey(
  scope: WorkspaceScope,
  sessionId: string,
  idempotencyKey: string,
  record: 'user' | 'assistant',
): string {
  return createHash('sha256')
    .update(`${scope.workspaceId}\0${scope.actorId}\0${sessionId}\0${idempotencyKey}\0${record}`)
    .digest('hex');
}

async function requireOwnedSession(
  tx: Tx,
  scope: WorkspaceScope,
  sessionId: string,
): Promise<void> {
  requireRole(scope, 'member');
  const session = await tx.session.findFirst({
    where: { id: sessionId, workspaceId: scope.workspaceId, actorId: scope.actorId },
    select: { id: true },
  });
  if (!session) throw new ForbiddenError('Oturum bu actor kapsaminda degil.', 'member');
}

/** Kullanici mesajini yazar ve en yeni tur penceresini kronolojik dondurur. */
export async function appendUserMessageAndLoadHistory(
  tx: Tx,
  scope: WorkspaceScope,
  input: { idempotencyKey?: string; sessionId: string; userText: string },
): Promise<PreparedTurn> {
  await requireOwnedSession(tx, scope, input.sessionId);
  if (input.idempotencyKey) {
    const userClientMessageId = turnRecordKey(scope, input.sessionId, input.idempotencyKey, 'user');
    const assistantClientMessageId = turnRecordKey(
      scope,
      input.sessionId,
      input.idempotencyKey,
      'assistant',
    );
    const pending = await tx.message.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        sessionId: input.sessionId,
        authorRole: 'user',
        clientMessageId: userClientMessageId,
        session: { actorId: scope.actorId },
      },
    });
    if (pending && pending.text !== input.userText) throw new IdempotencyConflictError();

    const completed = await tx.message.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        sessionId: input.sessionId,
        authorRole: 'assistant',
        clientMessageId: assistantClientMessageId,
        session: { actorId: scope.actorId },
      },
    });
    if (completed) {
      return {
        replay: {
          text: completed.text,
          ...(completed.inputTokens !== null ? { inputTokens: completed.inputTokens } : {}),
          ...(completed.outputTokens !== null ? { outputTokens: completed.outputTokens } : {}),
        },
      };
    }
    if (pending) {
      const ageMs = Date.now() - pending.createdAt.getTime();
      if (ageMs < STALE_PENDING_TURN_MS) {
        throw new TurnInProgressError(STALE_PENDING_TURN_MS - ageMs);
      }
    }

    // Terk edilmis claim varsa AYNI kullanici mesaji yeniden kullanilir (benzersiz
    // clientMessageId ikinci satira izin vermez); kronolojide sona tasinir ki
    // arada baska mesajlar yazilmissa bu tur en yeni mesaji yanitlasin.
    const userMessage = pending
      ? await tx.message.update({ where: { id: pending.id }, data: { createdAt: new Date() } })
      : await tx.message.create({
          data: {
            id: newMessageId(),
            workspaceId: scope.workspaceId,
            sessionId: input.sessionId,
            authorRole: 'user',
            text: input.userText,
            clientMessageId: userClientMessageId,
          },
        });
    const newestFirst = await tx.message.findMany({
      where: { workspaceId: scope.workspaceId, sessionId: input.sessionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: TURN_HISTORY_LIMIT,
    });
    return {
      assistantClientMessageId,
      userMessageId: userMessage.id,
      history: newestFirst.reverse(),
    };
  }

  const userMessage = await appendMessage(tx, scope, {
    sessionId: input.sessionId,
    authorRole: 'user',
    text: input.userText,
  });
  const newestFirst = await tx.message.findMany({
    where: { workspaceId: scope.workspaceId, sessionId: input.sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: TURN_HISTORY_LIMIT,
  });
  return { userMessageId: userMessage.id, history: newestFirst.reverse() };
}

/**
 * Basarisiz/iptal edilen turun claim'ini birakir: kullanici mesaji silinir, boylece
 * AYNI messageId ile yeniden deneme "halen isleniyor" yerine temiz baslar
 * (protokolun tek kurtarma vaadi budur, bkz. packages/protocol wire.ts). Birakma
 * basarisiz olursa hata yutulur ama loglanir: asil hata yukari gitmeli ve claim
 * en gec `STALE_PENDING_TURN_MS` sonra zaten terk edilmis sayilir.
 */
async function releaseTurnClaim(
  db: DbHandle,
  scope: WorkspaceScope,
  input: { sessionId: string; idempotencyKey: string },
): Promise<void> {
  try {
    await withScope(db.prisma, scope, (tx) =>
      tx.message.deleteMany({
        where: {
          workspaceId: scope.workspaceId,
          sessionId: input.sessionId,
          authorRole: 'user',
          clientMessageId: turnRecordKey(scope, input.sessionId, input.idempotencyKey, 'user'),
          session: { actorId: scope.actorId },
        },
      }),
    );
  } catch {
    console.error(
      '[gateway] basarisiz turun claim i birakilamadi; yeniden deneme beklemek zorunda',
    );
  }
}

/**
 * Claim alindiktan sonraki isi kosar. Is firlatirsa (model hatasi, iptal, kopma)
 * claim birakilir ve hata AYNEN yukari gider. Idempotency anahtari yoksa claim da yoktur.
 */
export async function runClaimedTurn<T>(
  db: DbHandle,
  scope: WorkspaceScope,
  claim: { sessionId: string; idempotencyKey?: string | undefined },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (claim.idempotencyKey) {
      await releaseTurnClaim(db, scope, {
        sessionId: claim.sessionId,
        idempotencyKey: claim.idempotencyKey,
      });
    }
    throw error;
  }
}

export async function completeTurn(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    assistantClientMessageId?: string;
    inputTokens?: number;
    outputTokens?: number;
    sessionId: string;
    text: string;
  },
): Promise<void> {
  await requireOwnedSession(tx, scope, input.sessionId);
  if (!input.assistantClientMessageId) {
    await appendMessage(tx, scope, {
      sessionId: input.sessionId,
      authorRole: 'assistant',
      text: input.text,
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    });
    return;
  }

  await tx.message.create({
    data: {
      id: newMessageId(),
      workspaceId: scope.workspaceId,
      sessionId: input.sessionId,
      authorRole: 'assistant',
      text: input.text,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      clientMessageId: input.assistantClientMessageId,
    },
  });
}

/** Kuyruk kesintisi tamamlanmis sohbet yanitini bloke etmez. */
export function scheduleMessageIndex(
  indexMessage: IndexMessageFn | undefined,
  sourceId: string,
): void {
  if (!indexMessage) return;
  void indexMessage({ sourceId }).catch(() => {
    console.error('[gateway] mesaj indeksleme kuyruguna teslim edilemedi');
  });
}

/**
 * Tek sohbet turu: kullanici mesajini kalici yaz → gecmisle birlikte modele
 * gonder → delta'lari akit → asistan cevabini kalici yaz.
 *
 * Kalicilik LLM cagrisindan AYRI transaction'larda yapilir; model 30 saniye
 * dusunurken Postgres transaction'i acik tutulmaz.
 */

const SYSTEM_PROMPT = [
  'Sen Smith’sin — kullanicinin kendi altyapisinda kosan kisisel yapay zeka asistani.',
  'Turkce konus; teknik terimleri English birak. Kisa, dogru ve dogrudan cevap ver.',
  'Bilmedigini uydurma; bilmiyorum demek gecerli bir cevaptir.',
].join(' ');

export interface TurnResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Recall hatasi gunlukte bu aralikta bir kez gorunur (her turda yazmak gurultu olurdu). */
const RECALL_LOG_INTERVAL_MS = 60_000;
let lastRecallLogAt = Number.NEGATIVE_INFINITY;

/**
 * Recall best-effort ama SESSIZ degil: embedding saglayicisi 401/kota verir ya da
 * DB havuzu dolarsa her turda hafiza baglami sessizce yok olur ve "hafiza calismiyor"
 * teshisi imkansizlasirdi (hafiza "olu" yanlis teshisi daha once yasandi). Yalniz
 * hata ADI yazilir; mesaj saglayici ayrintisi tasiyabilir.
 */
function reportRecallFailure(error: unknown): void {
  const current = Date.now();
  if (current - lastRecallLogAt < RECALL_LOG_INTERVAL_MS) return;
  lastRecallLogAt = current;
  console.error(
    `[gateway] hafiza baglami alinamadi (${error instanceof Error ? error.name : 'unknown'}); tur baglamsiz suruyor`,
  );
}

/**
 * Hafiza baglami (best-effort): hata sohbet turunu DURDURMAZ, model yalniz baglam
 * olmadan cevaplar.
 */
async function loadRecallBlock(input: {
  db: DbHandle;
  scope: WorkspaceScope;
  embedder: Embedder;
  userText: string;
  signal?: AbortSignal | undefined;
}): Promise<string | null> {
  const { db, scope } = input;
  try {
    // Sorgu uzak embedding saglayicisina gider: yalniz o girdi maskelenir
    // (mesajin kendisi DB'ye ve modele aynen gider). Tur iptal edilince ya da
    // gomme KENDI zaman asimini asinca uzak istek durur: asili bir gomme ucu
    // turu LLM cagrisindan ONCE kilitleyemez (SDK zaman asimi yalniz yanit
    // basligini kapsar).
    const embedSignal = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(EMBED_TIMEOUT_MS),
    ]);
    const queryEmbedding = await input.embedder.embed(redactSecrets(input.userText).text, {
      signal: embedSignal,
    });
    const hits = await withScope(db.prisma, scope, (tx) =>
      searchMemories(tx, scope, queryEmbedding, {
        limit: 5,
        // BENZERLIK TABANI: esiksiz recall her isteme en yakin 5 hafizayi —
        // ne kadar ALAKASIZ olsalar da — sistem prompt'una enjekte ediyordu.
        // Sahada sonuc: "hey" veya "adin ne" gibi selamlara model, baglamdaki
        // ilgisiz hafizayi papaganliyordu ("En sevdigim programlama dili…").
        // Kucuk modeller baglamdaki her cumleyi cevaplanmasi gereken bir
        // ipucu sanar; bu yuzden taban KAPI degil ZORUNLULUK.
        minSimilarity: 0.62,
        // GIZLILIK KAPISI (2026-08-15 denetiminde bulundu): bu cagri
        // `allowedSensitivity` VERMIYORDU, dolayisiyla `repo.ts`'in
        // varsayilanina dusuyor ve `secret` DAHIL oluyordu. Oysa hem
        // `schema.prisma` hem ADR 0004 "retrieval sinifa gore filtrelenir"
        // diye soz veriyor, ve Live yolu (`routes/tools.ts`) dogru
        // filtreliyordu — iki recall yolu sessizce ayrisimisti.
        //
        // Bugun zararsizdi cunku DB'de `secret` kaydi YOK; ama bu bir
        // ZAMANLAMA sansi, tasarim degil. Ilk `secret` kaydin yazildigi an
        // sessizce modele (ve bulut saglayicisina) giderdi. Sizinti kapilari
        // "henuz veri yok" diye acik birakilmaz.
        //
        // Burada hafiza OTOMATIK enjekte ediliyor (model istemiyor), yani
        // Live yolundan bile daha siki olmasi gereken yer burasi.
        allowedSensitivity: ['public', 'personal'],
      }),
    );
    return buildRecallBlock(hits);
  } catch (error) {
    // Kullanicinin kendi iptali hata degildir.
    if (!input.signal?.aborted) reportRecallFailure(error);
    return null;
  }
}

export async function runChatTurn(input: {
  db: DbHandle;
  llm: LlmRouter;
  /** Opsiyonel: yoksa retrieval sessizce atlanir (embedding saglayici yoksa). */
  embedder?: Embedder | undefined;
  /** Opsiyonel: kullanici mesajini asenkron indekslemek icin kuyruk baglantisi. */
  indexMessage?: IndexMessageFn | undefined;
  /** Actor + session kapsamli kalici tekrar engelleme anahtari. */
  idempotencyKey?: string | undefined;
  scope: WorkspaceScope;
  sessionId: string;
  userText: string;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
}): Promise<TurnResult> {
  const { db, llm, embedder, indexMessage, scope, sessionId, userText } = input;

  // Kalici claim, embedding dahil tum harici yan etkilerden once alinir.
  const prepared = await withScope(db.prisma, scope, (tx) =>
    appendUserMessageAndLoadHistory(tx, scope, {
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      sessionId,
      userText,
    }),
  );
  if (prepared.replay) {
    input.onDelta(prepared.replay.text);
    return prepared.replay;
  }
  const { assistantClientMessageId, history, userMessageId } = prepared;
  if (!history || !userMessageId) throw new Error('Turn hazirligi eksik sonuc dondurdu.');

  return runClaimedTurn(
    db,
    scope,
    { sessionId, idempotencyKey: input.idempotencyKey },
    async () => {
      // 1. Kullanici mesajini embed et ve benzer gecmis hafizalari getir.
      //    Hafiza best-effort: embedding basarisiz olursa sohbet turu DURMAZ,
      //    yalniz gecmis baglam olmadan devam eder.
      const recallBlock = embedder
        ? await loadRecallBlock({ db, scope, embedder, userText, signal: input.signal })
        : null;

      const systemContent = recallBlock ? `${SYSTEM_PROMPT}\n\n${recallBlock}` : SYSTEM_PROMPT;
      const messages: ChatMessage[] = [
        { role: 'system', content: systemContent },
        ...history.map((m): ChatMessage => ({
          role: m.authorRole === 'user' ? 'user' : 'assistant',
          content: m.text,
        })),
      ];

      // 3. Modeli akit (transaction disi).
      const result = await llm.streamChat('chat', messages, {
        ...(input.signal ? { signal: input.signal } : {}),
        onDelta: input.onDelta,
      });

      // 4. Asistan cevabini kalici yaz.
      await withScope(db.prisma, scope, (tx) =>
        completeTurn(tx, scope, {
          ...(assistantClientMessageId ? { assistantClientMessageId } : {}),
          sessionId,
          text: result.text,
          ...(result.usage
            ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
            : {}),
        }),
      );

      // 5. Kullanici mesajini asenkron indekslemek icin kuyruga at. Embedding
      //    + yazma artik worker'da; sohbet turu kritik yolunda degil. Best-effort:
      //    enqueue hatasi cevabi etkilemez.
      scheduleMessageIndex(indexMessage, userMessageId);

      return {
        text: result.text,
        ...(result.usage
          ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
          : {}),
      };
    },
  );
}
