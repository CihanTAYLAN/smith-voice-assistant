import { findMessage, withScope, type DbHandle } from '@smith/db';
import {
  EMBED_TIMEOUT_MS,
  contextExcluded,
  redactSecrets,
  upsertMemory,
  type Embedder,
} from '@smith/memory';
import type { MemoryIndexJob } from '@smith/queue';
import { createWorkspaceScope } from '@smith/tenancy';

/**
 * MEMORY_INDEX tuketicisi: bir kaynagi (mesaj) embed edip Memory'ye yazar.
 *
 * Kapsam: payload workspaceId + actorId tasir. Worker bunlardan bir
 * WorkspaceScope kurar ('member' rolu — upsert bunu ister) ve scoped tx icinde
 * calisir; yani RLS oturum degiskeni set edilir, yazma dogru tenant'a gider.
 * actorId yoksa (sistem tetikli) is basarisiz olur — kapsamsiz yazma yok.
 *
 * ZAMAN ASIMI: embedding cagrisi `AbortSignal.timeout` ile sinirlidir; asili bir
 * uc bu kuyrugu (BullMQ varsayilani: es zamanlilik 1) ve kapanisi dakikalarca
 * kilitlemesin.
 */
export async function handleMemoryIndex(
  deps: { db: DbHandle; embedder: Embedder },
  payload: MemoryIndexJob,
): Promise<void> {
  if (!payload.actorId) {
    throw new Error('MEMORY_INDEX actorId gerektirir (kapsamsiz yazma yasak).');
  }
  const scope = createWorkspaceScope({
    workspaceId: payload.workspaceId,
    actorId: payload.actorId,
    role: 'member',
  });

  if (payload.kind !== 'message') {
    throw new Error(`Desteklenmeyen kaynak turu: ${payload.kind}`);
  }

  const message = await withScope(deps.db.prisma, scope, (tx) =>
    findMessage(tx, scope, payload.sourceId),
  );
  // Mesaj yoksa (silinmis) is sessizce tamamlanir — yeniden denemek anlamsiz.
  if (!message) return;

  const safe = redactSecrets(message.text);
  if (safe.secretOnly) return;
  if (contextExcluded({ sourceId: message.id, content: safe.text })) return;
  const embedding = await deps.embedder.embed(safe.text, {
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  await withScope(deps.db.prisma, scope, (tx) =>
    upsertMemory(tx, scope, {
      sourceType: 'message',
      sourceId: message.id,
      content: safe.text,
      embedding,
    }),
  );
}
