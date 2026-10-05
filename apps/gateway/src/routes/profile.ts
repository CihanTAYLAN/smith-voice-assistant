import { type DbHandle, listDevices, withScope } from '@smith/db';
import {
  type Embedder,
  contextExcluded,
  countMemories,
  deleteMemory,
  listMemories,
  redactSecrets,
  upsertMemory,
} from '@smith/memory';
import { ForbiddenError, requireRole, type WorkspaceScope } from '@smith/tenancy';
import { Hono } from 'hono';
import { z } from 'zod';

import { scopeFromAuthHeader } from '../bearer.js';
import { reminderBodyLimit } from './reminders-body-limit.js';

/**
 * KISISEL PROFIL (`/v1/tools/profile`): sehir, dogum gunu gibi temel bilgiler
 * her oturumun basinda hazir beklesin diye. Tetikleyen olay: Smith "hangi
 * sehirde yasiyoruz" sorusuna "bilmiyorum" dedi.
 *
 * KAPSAM (kullanici karari): yalniz "hatirla" denenler ve yapisal bilgiler;
 * konusmadan CIKARIM YAPILMAZ. Gateway profile kendiliginden hicbir sey
 * eklemez, yazan taraf acikca POST eder.
 *
 * DEPOLAMA: Memory tablosu, sourceType `profile`, sourceId `profile:<anahtar>`;
 * migration yok. `content` degerin kendisidir, anahtar sourceId'den turer.
 * Memory'de updatedAt yok: POST satiri silip AYNI transaction'da yeniden
 * yazar, boylece createdAt (= `guncellendi`) son yazimi gosterir. Silmenin
 * sonucu ayrica "anahtar var miydi" sorusunu cevaplar (kota).
 *
 * SIR TASIMAZ: profil her oturum basinda buluttaki modele gider. Sir bulunursa
 * 400; sinif daima `personal`, okuma yolu ise `secret`'i ayrica disarida tutar
 * (satir `/memory/remember` ile baska yoldan yazilmis olsa bile).
 */

export const PROFILE_SOURCE_TYPE = 'profile';
export const PROFILE_SOURCE_ID_PREFIX = 'profile:';
const MAX_ENTRIES = 50;
const MAX_VALUE_CHARS = 300;

const KEY_ERROR = 'anahtar 2-40 karakter: kucuk harf, rakam, alt cizgi (ASCII)';
const VALUE_ERROR = `deger 1-${MAX_VALUE_CHARS} karakter ve tek satir olmali`;
const BODY_ERROR = 'govde {"anahtar", "deger"} iceren bir JSON nesnesi olmali';

const sourceIdOf = (key: string) => `${PROFILE_SOURCE_ID_PREFIX}${key}`;

/** ASCII: model Turkceyi cevirir (sehir, dogum_gunu). */
const keySchema = z.string().regex(/^[a-z0-9_]{2,40}$/);

const writeSchema = z.object({
  anahtar: keySchema,
  deger: z
    .string()
    .trim()
    .min(1)
    .refine((value) => [...value].length <= MAX_VALUE_CHARS)
    // Tek satir: satir sonu ve kontrol karakterleri, her oturum basinda modele
    // giden profil metninin bicimini bozabilir.
    .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)),
});

/** Ilk gecersiz alana gore tek, anlasilir mesaj. */
function writeError(error: z.ZodError): string {
  const field = error.issues[0]?.path[0];
  if (field === 'anahtar') return KEY_ERROR;
  if (field === 'deger') return VALUE_ERROR;
  return BODY_ERROR;
}

export function createProfileRoutes(deps: {
  db: DbHandle;
  sessionSecret: string;
  embedder: Embedder;
}) {
  const app = new Hono<{ Variables: { scope: WorkspaceScope } }>();

  // Okuma her uye rolune acik; yazma ve silme en az 'member'. Viewer govdeye,
  // embedding'e ve DB'ye inmeden 403 alir.
  app.use('*', async (c, next) => {
    const scope = scopeFromAuthHeader(deps.sessionSecret, c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      try {
        requireRole(scope, 'member');
      } catch (error) {
        if (error instanceof ForbiddenError) return c.json({ error: error.message }, 403);
        throw error;
      }
    }
    c.header('Cache-Control', 'no-store');
    c.set('scope', scope);
    await next();
  });

  app.use('*', reminderBodyLimit);

  // Embedding cagirmaz: masaustu her oturum acilisinda bunu okuyacak.
  app.get('/', async (c) => {
    const scope = c.get('scope');
    const { rows, devices } = await withScope(deps.db.prisma, scope, async (tx) => ({
      rows: await listMemories(tx, scope, {
        sourceType: PROFILE_SOURCE_TYPE,
        allowedSensitivity: ['public', 'personal'],
        limit: MAX_ENTRIES,
      }),
      devices: await listDevices(tx, scope),
    }));
    return c.json({
      // Oneksiz 'profile' satiri baska yoldan (`/memory/remember`) gelmistir:
      // anahtari yoktur, listeye girmez.
      entries: rows
        .filter((row) => row.sourceId.startsWith(PROFILE_SOURCE_ID_PREFIX))
        .map((row) => ({
          anahtar: row.sourceId.slice(PROFILE_SOURCE_ID_PREFIX.length),
          deger: row.content,
          guncellendi: row.createdAt,
        })),
      // Beyaz liste: kimlik ve workspace alanlari yanita girmez.
      cihazlar: devices.map((device) => ({
        ad: device.name,
        yuzey: device.surface,
        sonGorulme: device.lastSeenAt.toISOString(),
      })),
    });
  });

  app.post('/', async (c) => {
    const scope = c.get('scope');
    const body = writeSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: writeError(body.error) }, 400);
    const { anahtar, deger } = body.data;

    // Etiket anahtarda olabilir ("sifre" -> "12345", "db_password"): sir denetimi ve
    // embedding girdisi etiketli satirdir. `redactSecrets` alt cizgili etiketleri
    // (`api_key`, `db_password`) kendisi yakalar.
    const redacted = redactSecrets(`${anahtar}: ${deger}`);
    if (redacted.found) {
      return c.json(
        { error: 'profil sir icermez; gizli bilgiyi hafizaya gizli not olarak kaydet' },
        400,
      );
    }

    const sourceId = sourceIdOf(anahtar);
    if (contextExcluded({ sourceId, content: deger })) {
      return c.json({ ok: true, anahtar, excluded: true });
    }

    // `c.req.raw.signal`: istemci kopunca uzak embedding istegi de durur.
    const embedding = await deps.embedder.embed(redacted.text, { signal: c.req.raw.signal });

    // Silme ve yazma TEK transaction: yazim yarida kalirsa silme de geri alinir,
    // eski deger kaybolmaz. Ayni anahtara eszamanli iki yazim ikisi de silmeyi
    // bitirip yazmaya gecebilir; `upsertMemory`nin ON CONFLICT'i ikincisini
    // hataya dusurmeden tek satira indirir (son yazan kazanir).
    const stored = await withScope(deps.db.prisma, scope, async (tx) => {
      const source = { sourceType: PROFILE_SOURCE_TYPE, sourceId };
      const existed = await deleteMemory(tx, scope, source);
      if (
        !existed &&
        (await countMemories(tx, scope, { sourceType: PROFILE_SOURCE_TYPE })) >= MAX_ENTRIES
      ) {
        return false;
      }
      await upsertMemory(tx, scope, {
        ...source,
        content: deger,
        embedding,
        sensitivity: 'personal',
      });
      return true;
    });
    if (!stored) {
      return c.json(
        { error: `profil en fazla ${MAX_ENTRIES} anahtar tasir; once birini sil` },
        409,
      );
    }
    return c.json({ ok: true, anahtar });
  });

  app.delete('/:anahtar', async (c) => {
    const scope = c.get('scope');
    const key = keySchema.safeParse(c.req.param('anahtar'));
    if (!key.success) return c.json({ error: KEY_ERROR }, 400);
    const silindi = await withScope(deps.db.prisma, scope, (tx) =>
      deleteMemory(tx, scope, { sourceType: PROFILE_SOURCE_TYPE, sourceId: sourceIdOf(key.data) }),
    );
    return c.json({ ok: true, silindi });
  });

  return app;
}
