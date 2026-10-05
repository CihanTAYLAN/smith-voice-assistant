import { newMemoryId, type Tx } from '@smith/db';
import { requireRole, type WorkspaceScope } from '@smith/tenancy';

import { contextExcluded, type ContextExcludeRules } from './context-exclude.js';
import { toVectorLiteral } from './embedder.js';
import { lockMemoryMaintenance } from './maintenance-repo.js';

/**
 * Semantik hafiza repository'si. Her fonksiyon WorkspaceScope ister ve scoped
 * transaction (Tx) icinde cagrilir — yani RLS oturum degiskeni set edilmistir.
 *
 * Iki katmanli savunma burada da gecerli: SQL'de acik workspace filtresi VAR
 * (birinci katman) ama RLS de her satiri ayrica tutuyor (ikinci katman, son
 * soz). Ikisi birden yanlislikla dusse bile digeri korur.
 */

export interface MemoryHit {
  id: string;
  content: string;
  sourceType: string;
  sourceId: string;
  /** 0..1 arasi cosine benzerligi (1 = ozdes). */
  similarity: number;
}

/**
 * Bir kaynagi hafizaya yazar/gunceller. (workspaceId, sourceType, sourceId)
 * benzersiz oldugu icin ayni kaynak iki kez indekslenmez — tekrar cagri
 * embedding'i tazeler.
 *
 * embedding kolonu Prisma Unsupported oldugu icin $executeRaw ile yazilir;
 * vektor pgvector literal'i olarak parametrelenir.
 */
export async function upsertMemory(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    // Konnektorler yeni tur ekliyor (github/obsidian/device...) → string.
    sourceType: string;
    sourceId: string;
    content: string;
    embedding: number[];
    /**
     * Gizlilik sinifi (ADR 0004): public | personal | secret. Retrieval buna
     * gore filtreler; Live modunda `secret` modele ENJEKTE EDILMEZ (ses+baglam
     * buluta gidiyor). Varsayilan `personal` — belirtmeyen cagirici en guvenli
     * ortayi alir.
     */
    sensitivity?: 'public' | 'personal' | 'secret';
    /** Test ve yonetim araclari icin env kuralini acikca ezme noktasi. */
    contextExclude?: string | ContextExcludeRules;
  },
): Promise<void> {
  requireRole(scope, 'member');
  if (contextExcluded({ sourceId: input.sourceId, content: input.content }, input.contextExclude))
    return;
  const id = newMemoryId();
  const vector = toVectorLiteral(input.embedding);
  const sensitivity = input.sensitivity ?? 'personal';

  // Ayri statement: kilit beklerken bakim commit ederse CTE yeni snapshot'i gorur.
  await lockMemoryMaintenance(tx, scope);

  // ON CONFLICT: ayni kaynak yeniden indekslenirse icerik + embedding + sinif tazelenir.
  await tx.$executeRaw`
    WITH input AS (
      SELECT ${id}::text AS "id", ${scope.workspaceId}::text AS "workspaceId",
        ${input.sourceType}::text AS "sourceType", ${input.sourceId}::text AS "sourceId",
        ${input.content}::text AS "content", ${vector}::vector AS "embedding", ${sensitivity}::text AS "sensitivity"
    ), archived AS (
      UPDATE "Memory" m SET "sourceId" = m."sourceId" || ':superseded:' || m."id"
      FROM input i WHERE m."workspaceId" = i."workspaceId" AND m."sourceType" = i."sourceType"
        AND m."sourceId" = i."sourceId" AND m."status" = 'superseded'
        AND (m."content" IS DISTINCT FROM i."content" OR m."sensitivity" IS DISTINCT FROM i."sensitivity")
      RETURNING m."id"
    )
    INSERT INTO "Memory" ("id", "workspaceId", "sourceType", "sourceId", "content", "embedding", "sensitivity")
    SELECT i.* FROM input i CROSS JOIN (SELECT count(*) FROM archived) completed WHERE true
    ON CONFLICT ("workspaceId", "sourceType", "sourceId")
    DO UPDATE SET "content" = EXCLUDED."content", "embedding" = EXCLUDED."embedding", "sensitivity" = EXCLUDED."sensitivity"
    WHERE "Memory"."status" = 'active'
  `;
}

/**
 * Sorgu vektorune en yakin K hafizayi dondurur (cosine).
 *
 * <=> pgvector cosine mesafe operatorudur (0 = ozdes, 2 = zit). Benzerlik =
 * 1 - mesafe. HNSW index bu operatoru kullanir.
 *
 * WHERE'de workspace filtresi acikca var; RLS zaten tx'te aktif. minSimilarity
 * alakasiz sonuclari eler — bos sonuc, alakasiz baglamdan iyidir.
 */
export async function searchMemories(
  tx: Tx,
  scope: WorkspaceScope,
  queryEmbedding: number[],
  options: {
    limit?: number;
    minSimilarity?: number;
    /**
     * Izin verilen gizlilik siniflari (ADR 0004). Verilmezse hepsi. Live
     * modunda cagirici `['public','personal']` gecerek `secret`'i disarida
     * tutar — o icerik buluttaki modele hic ulasmaz.
     */
    allowedSensitivity?: string[];
    contextExclude?: string | ContextExcludeRules;
  } = {},
): Promise<MemoryHit[]> {
  const limit = options.limit ?? 5;
  const minSimilarity = options.minSimilarity ?? 0.3;
  // VARSAYILAN FAIL-CLOSED (2026-08-15 denetimi): eskiden varsayilan
  // `['public','personal','secret']` idi, yani `allowedSensitivity` VERMEYEN bir
  // cagiran `secret` hafizalari da geri aliyordu. `apps/gateway/src/turn.ts`
  // tam olarak bunu yapiyordu ve sohbet turu recall'i gizli kayitlari modele
  // (ve bulut saglayicisina) enjekte etmeye hazirdi; yalnizca DB'de henuz
  // `secret` kayit olmadigi icin zarar gormedik. Bu bir ZAMANLAMA sansiydi.
  //
  // `secret` bir YAZMA sinifidir (`remember` kabul eder); geri getirmede onu
  // isteyen HICBIR cagiran yok (iki cagirma noktasi da acikca sinirliyor).
  // O yuzden varsayilan artik kapali: unutulan bir parametre sizdiramaz,
  // gizliyi gormek isteyen ACIKCA istemek zorunda.
  const allowed = options.allowedSensitivity ?? ['public', 'personal'];
  const vector = toVectorLiteral(queryEmbedding);

  const rows = await tx.$queryRaw<
    { id: string; content: string; sourceType: string; sourceId: string; similarity: number }[]
  >`
    SELECT "id", "content", "sourceType", "sourceId",
           1 - ("embedding" <=> ${vector}::vector) AS "similarity"
    FROM "Memory"
    WHERE "workspaceId" = ${scope.workspaceId}
      AND "status" = 'active'
      AND "embedding" IS NOT NULL
      AND "sensitivity" = ANY(${allowed}::text[])
      AND 1 - ("embedding" <=> ${vector}::vector) >= ${minSimilarity}
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
  return rows.filter(
    (row) =>
      !contextExcluded({ sourceId: row.sourceId, content: row.content }, options.contextExclude),
  );
}

/** Dashboard listesinin bir satiri: icerik 1200 karakterde KIRPILIR. */
export interface MemoryRow {
  id: string;
  content: string;
  sourceType: string;
  sourceId: string;
  sensitivity: string;
  createdAt: string;
  status: string;
  supersededById: string | null;
}

/**
 * Son kayitlar (salt-okuma dashboard tarayicisi; model araci DEGIL).
 *
 * `secret` sinifi VARSAYILANDA dahildir: cagri yerel paneledir, buluta
 * gitmez. Modele donen yollar secret'i disarida tutar (`searchMemories`,
 * ve listeyi buluta verecek cagiranin gecirdigi `allowedSensitivity`); bu
 * ayrim bilincli (ADR 0004). Filtre SQL `where`ine girer, TS tarafinda
 * suzulmez.
 *
 * KIRPMA: icerik 1200 karaktere indirilir; 300 kayitlik liste yanitini
 * megabaytlara sisirmemek icin. Tam metin, arama yolundan gelir.
 */
export async function listMemories(
  tx: Tx,
  scope: WorkspaceScope,
  options: {
    limit?: number;
    sourceType?: string;
    allowedSensitivity?: string[];
    includeSuperseded?: boolean;
    contextExclude?: string | ContextExcludeRules;
  } = {},
): Promise<MemoryRow[]> {
  const limit = options.limit ?? 100;
  const rows = await tx.memory.findMany({
    where: {
      workspaceId: scope.workspaceId,
      ...(options.includeSuperseded ? {} : { status: 'active' }),
      ...(options.sourceType ? { sourceType: options.sourceType } : {}),
      ...(options.allowedSensitivity ? { sensitivity: { in: options.allowedSensitivity } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      content: true,
      sourceType: true,
      sourceId: true,
      sensitivity: true,
      createdAt: true,
      status: true,
      supersededById: true,
    },
  });
  return rows
    .filter(
      (row) =>
        !contextExcluded({ sourceId: row.sourceId, content: row.content }, options.contextExclude),
    )
    .map((r) => ({
      id: r.id,
      content: r.content.length > 1200 ? `${r.content.slice(0, 1200)}…` : r.content,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      sensitivity: r.sensitivity,
      createdAt: r.createdAt.toISOString(),
      status: r.status,
      supersededById: r.supersededById,
    }));
}

/**
 * Tek kaynak satirini siler: (workspaceId, sourceType, sourceId) benzersiz
 * oldugu icin en fazla bir satir. Satir yoksa `false` doner: "zaten yok" hata
 * degildir, silme idempotenttir.
 */
export async function deleteMemory(
  tx: Tx,
  scope: WorkspaceScope,
  source: { sourceType: string; sourceId: string },
): Promise<boolean> {
  requireRole(scope, 'member');
  const { count } = await tx.memory.deleteMany({
    where: {
      workspaceId: scope.workspaceId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
    },
  });
  return count > 0;
}

/** Bir kaynak turundeki kayit sayisi (kota denetimi icin). */
export async function countMemories(
  tx: Tx,
  scope: WorkspaceScope,
  options: { sourceType: string },
): Promise<number> {
  return tx.memory.count({
    where: { workspaceId: scope.workspaceId, sourceType: options.sourceType, status: 'active' },
  });
}
