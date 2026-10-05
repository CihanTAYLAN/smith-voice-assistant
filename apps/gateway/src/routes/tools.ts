import { type DbHandle, withScope } from '@smith/db';
import {
  type Embedder,
  contextExcluded,
  listMemories,
  redactSecrets,
  searchMemories,
  upsertMemory,
} from '@smith/memory';
import { ForbiddenError, requireRole } from '@smith/tenancy';
import { Hono } from 'hono';
import { z } from 'zod';

import { memorySourceId, prepareMemoryWrite } from '../agent/tools.js';
import { scopeFromAuthHeader } from '../bearer.js';
import { createProfileRoutes, PROFILE_SOURCE_ID_PREFIX, PROFILE_SOURCE_TYPE } from './profile.js';
import { createReminderRoutes } from './reminders.js';

/**
 * ARAC UCLARI (`/v1/tools/*`) — Live oturumunun (speech-to-speech) hafizaya ve
 * ileride sistem araclarina eristigi yol.
 *
 * NEDEN AYRI BIR YUZEY: Live modunda konusma tek bir WebSocket'te Google ile
 * gerceklesir; gateway'in sohbet turu (`/v1/ws` + `runChatTurn`) devrede DEGIL.
 * Bu yuzden Smith'in hafizasi Live modunda otomatik calismiyordu — kullanici
 * "hafizasi yok" dedi. Cozum: modele arac tanit, arac cagrisini masaustu
 * (Rust) buraya HTTP ile getirsin. Hafiza ve tenancy boylece TEK yerde kalir;
 * @smith/protocol degismez.
 *
 * Yetki: `Authorization: Bearer <access token>` — WS ile ayni token. Scope
 * token'dan cikar, RLS `withScope` ile uygulanir. Araclar kiraci sinirini
 * ASLA gecmez.
 */

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});
const rememberSchema = z.object({
  content: z.string().min(3),
  key: z.string().min(1).optional(),
  sourceType: z.string().min(1).optional(),
  sensitivity: z.enum(['public', 'personal', 'secret']).optional(),
});

export function createToolRoutes(deps: {
  db: DbHandle;
  sessionSecret: string;
  embedder: Embedder;
}): Hono {
  const app = new Hono();
  app.route('/reminders', createReminderRoutes(deps));
  app.route('/profile', createProfileRoutes(deps));

  /** Token'dan WorkspaceScope kurar; gecersizse null (bkz. src/bearer.ts). */
  const scopeOf = (authHeader: string | undefined) =>
    scopeFromAuthHeader(deps.sessionSecret, authHeader);

  /** Hafizada ara — Live modelinin "hatirla" araci. */
  app.post('/memory/search', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = searchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'query gerekli' }, 400);

    // Sorgu uzak embedding saglayicisina gider: yalniz o girdi maskelenir.
    // `c.req.raw.signal`: istemci kopunca uzak embedding istegi de durur.
    const embedding = await deps.embedder.embed(redactSecrets(body.data.query).text, {
      signal: c.req.raw.signal,
    });
    const hits = await withScope(deps.db.prisma, scope, (tx) =>
      searchMemories(tx, scope, embedding, {
        limit: body.data.limit ?? 5,
        // Live modu buluta gidiyor → `secret` hicbir zaman modele donmez.
        allowedSensitivity: ['public', 'personal'],
        // TABAN BURADA DAHA GEVSEK (0.35), `turn.ts`'teki 0.62 DEGIL — bilincli:
        // orada hafiza her isteme OTOMATIK enjekte ediliyor, alakasiz sonuc
        // zarar veriyor. Burada model ACIKCA ariyor ve donen sonucun alakasini
        // kendisi tartiyor; sıkı taban bu durumda "hicbir sey hatirlamiyor"
        // demek olur (0.62 ile "asistanin adi ne" sorgusu bos donmustu).
        minSimilarity: 0.35,
      }),
    );
    return c.json({
      results: hits.map((h) => ({
        content: h.content,
        similarity: Number(h.similarity.toFixed(3)),
      })),
    });
  });

  /**
   * Hafiza listesi — SMITH DASHBOARD icin (salt okuma; model araci DEGIL).
   * `secret` sinifi dahildir: cagri yereldir, buluta gitmez (ADR 0004 ayrimi:
   * modele donen yol `search`tir ve orasi secret'i disarida tutar).
   */
  app.get('/memory/list', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const rawLimit = Number(c.req.query('limit') ?? '100');
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500)
      : 100;
    const sourceType = c.req.query('sourceType');
    const includeSuperseded = c.req.query('includeSuperseded');
    if (includeSuperseded !== undefined && !['true', 'false'].includes(includeSuperseded))
      return c.json({ error: 'includeSuperseded true veya false olmali' }, 400);
    const records = await withScope(deps.db.prisma, scope, (tx) =>
      listMemories(tx, scope, {
        limit,
        includeSuperseded: includeSuperseded === 'true',
        ...(sourceType ? { sourceType } : {}),
      }),
    );
    return c.json({ records });
  });

  /** Hafizaya yaz — Live modelinin "not al" araci. */
  app.post('/memory/remember', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = rememberSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'content gerekli (en az 3 karakter)' }, 400);

    // Profil satirlari yalniz /v1/tools/profile ile yazilir: tek satir, 300 karakter,
    // 50 anahtar kotasi ve sir denetimi orada. Buradan yazilirsa bu kurallar atlanir ve
    // her oturum basinda buluttaki modele enjekte edilen profile girer.
    if (
      body.data.sourceType === PROFILE_SOURCE_TYPE ||
      body.data.key?.startsWith(PROFILE_SOURCE_ID_PREFIX)
    ) {
      return c.json({ error: 'profil satirlari yalniz /v1/tools/profile ile yazilir' }, 400);
    }

    try {
      requireRole(scope, 'member');
      const sourceId = body.data.key ?? memorySourceId('voice', body.data.content);
      if (contextExcluded({ sourceId, content: body.data.content })) {
        return c.json({ ok: true, sourceId, excluded: true });
      }
      const write = prepareMemoryWrite(body.data.content, body.data.sensitivity);
      const embedding = await deps.embedder.embed(write.embeddingText, {
        signal: c.req.raw.signal,
      });
      // sourceId: ayni notu iki kez yazmamak icin cagirandan gelebilir; yoksa
      // icerikten tureyen kararli bir anahtar uretilir (tekrar cagri tazeler).
      await withScope(deps.db.prisma, scope, (tx) =>
        upsertMemory(tx, scope, {
          sourceType: body.data.sourceType ?? 'note',
          sourceId,
          content: body.data.content,
          embedding,
          sensitivity: write.sensitivity,
        }),
      );
      return c.json({ ok: true, sourceId });
    } catch (error) {
      if (error instanceof ForbiddenError) return c.json({ error: error.message }, 403);
      throw error;
    }
  });

  return app;
}
