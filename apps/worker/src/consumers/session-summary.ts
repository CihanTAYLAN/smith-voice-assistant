import { listSessionMessages, withScope, type DbHandle } from '@smith/db';
import type { ChatMessage, LlmRouter } from '@smith/llm';
import {
  EMBED_TIMEOUT_MS,
  contextExcluded,
  redactSecrets,
  upsertMemory,
  type Embedder,
} from '@smith/memory';
import type { SessionSummaryJob } from '@smith/queue';
import { createWorkspaceScope } from '@smith/tenancy';

/**
 * Ozet LLM cagrisinin (yedek zinciri DAHIL) toplam ust suresi. Router tek
 * denemeyi (varsayilan 45 sn) sinirlar; bu tavan zincirin tamamini sinirlar ki
 * asili bir saglayici worker'i dakikalarca tutmasin. Tek denemeden BUYUK olmak
 * zorunda: aksi halde yedek halka hic denenemezdi.
 */
export const SUMMARY_LLM_TIMEOUT_MS = 120_000;

/**
 * SESSION_SUMMARY tuketicisi: uzun bir oturumu ozetler ve ozeti Memory'ye
 * 'note' olarak yazar. Boylece eski oturumlar tek tek mesaj yerine tek bir
 * damitilmis notla hatirlanir — baglam butcesini korur.
 *
 * Ozet 'summarizer' rolunden gecer (ucuz/hizli model). Ozetin kendisi de
 * embed edilip aranabilir hale gelir; sourceId = 'summary:<sessionId>' ile
 * benzersiz.
 *
 * URETICI: gateway'in `conversation/append` rotasi (Live konusmalari). Her tur
 * oturumun ozet isini bosta kalma penceresi kadar ileri iter; is yalniz
 * oturum kapandiktan sonra kosar (bkz. gateway session-summary-scheduler).
 *
 * IDEMPOTENT: ayni oturumun ozeti varsa is LLM'e HIC gitmeden biter. Oturum
 * kapandiktan sonra yeni mesaj almaz, yani ikinci ozet yeni bilgi
 * tasimaz; yeniden deneme/cift tetikleme ikinci kez para harcamaz.
 *
 * GIZLILIK: ozet acikca 'personal' yazilir (varsayilana birakilmaz). Ozetleyici
 * parola/anahtar/token'i metne almamakla yukumludur (prompt); `secret` sinifi
 * burada UYGULANMAZ cunku konusmadan otomatik gizlilik siniflandirmasi yok.
 */
export async function handleSessionSummary(
  deps: { db: DbHandle; llm: LlmRouter; embedder: Embedder },
  payload: SessionSummaryJob,
): Promise<void> {
  if (!payload.actorId) {
    throw new Error('SESSION_SUMMARY actorId gerektirir (kapsamsiz okuma/yazma yasak).');
  }
  const scope = createWorkspaceScope({
    workspaceId: payload.workspaceId,
    actorId: payload.actorId,
    role: 'member',
  });

  const summarySourceId = `summary:${payload.sessionId}`;
  const already = await withScope(deps.db.prisma, scope, (tx) =>
    tx.memory.findFirst({
      where: { workspaceId: scope.workspaceId, sourceType: 'note', sourceId: summarySourceId },
      select: { id: true },
    }),
  );
  if (already) return;

  const messages = await withScope(deps.db.prisma, scope, (tx) =>
    listSessionMessages(tx, scope, payload.sessionId, 200),
  );
  if (messages.length < payload.minMessages) return;

  const safeMessages = messages
    .map((message) => ({ message, safe: redactSecrets(message.text) }))
    .filter(
      ({ safe }) =>
        !safe.secretOnly && !contextExcluded({ sourceId: summarySourceId, content: safe.text }),
    );
  if (safeMessages.length < payload.minMessages) return;

  const transcript = safeMessages
    .map(
      ({ message, safe }) =>
        `${message.authorRole === 'user' ? 'Kullanici' : 'Smith'}: ${safe.text}`,
    )
    .join('\n');

  const prompt: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Asagidaki sohbeti kullanicinin gelecekte hatirlanmasi gereken kalici ' +
        'tercihleri, olgulari ve kararlari acisindan 3-5 madde halinde ozetle. ' +
        'Gecici detaylari atla. Parola, anahtar, token ve benzeri gizli ' +
        'degerleri ASLA yazma. Sadece maddeleri yaz.',
    },
    { role: 'user', content: transcript },
  ];

  const result = await deps.llm.streamChat('summarizer', prompt, {
    signal: AbortSignal.timeout(SUMMARY_LLM_TIMEOUT_MS),
  });
  const summaryResult = redactSecrets(result.text.trim());
  if (!summaryResult.text || summaryResult.secretOnly) {
    throw new Error('Ozetleyici bos veya yalnizca secret bir sonuc dondurdu.');
  }
  const summary = summaryResult.text;
  if (contextExcluded({ sourceId: summarySourceId, content: summary })) return;

  const embedding = await deps.embedder.embed(summary, {
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  await withScope(deps.db.prisma, scope, (tx) =>
    upsertMemory(tx, scope, {
      sourceType: 'note',
      sourceId: summarySourceId,
      content: summary,
      embedding,
      sensitivity: 'personal',
    }),
  );
}
