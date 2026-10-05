import { ToolRegistry, defineTool } from '@smith/core';
import { listDevices, withScope, type DbHandle } from '@smith/db';
import {
  contextExcluded,
  redactSecrets,
  searchMemories,
  upsertMemory,
  type Embedder,
} from '@smith/memory';
import { isSystemScope, requireRole } from '@smith/tenancy';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Gateway'in ajan tool-loop'una kayitli SUNUCU araclari.
 *
 * Bugun yalniz hafiza araclari: kapsamli (RLS), kod CALISTIRMAZ, egress YOK —
 * yani ADR 0003'un sandbox'a kadar ertelemeyi sart kostugu "keyfi yurutme"
 * sinifi DEGIL, guvenli veri islemleri. Kabuk/dosya gibi keyfi-exec araclari
 * Faz 3 (sandbox runner + egress proxy) gelene kadar EKLENMEZ.
 */
export function buildAgentRegistry(deps: { db: DbHandle; embedder: Embedder }): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    defineTool({
      name: 'hafizada_ara',
      description: 'Kullanicinin gecmis hafizalarinda anlamsal arama yapar; ilgili notlari doner.',
      parameters: z.object({
        query: z.string().min(1).describe('aranacak metin'),
        limit: z.number().int().min(1).max(10).optional().describe('en fazla sonuc (varsayilan 5)'),
      }),
      execute: async (input, ctx) => {
        const scope = ctx.scope;
        if (isSystemScope(scope)) return { error: 'workspace scope gerekli' };
        // Sorgu uzak embedding saglayicisina gider: yalniz o girdi maskelenir.
        const embedding = await deps.embedder.embed(redactSecrets(input.query).text, {
          signal: ctx.signal,
        });
        const hits = await withScope(deps.db.prisma, scope, (tx) =>
          searchMemories(tx, scope, embedding, {
            limit: input.limit ?? 5,
            // Sohbet turu buluta gidebilir → `secret` modele donmez (ADR 0004).
            allowedSensitivity: ['public', 'personal'],
            minSimilarity: 0.35,
          }),
        );
        return {
          results: hits.map((h) => ({
            content: h.content,
            similarity: Number(h.similarity.toFixed(3)),
          })),
        };
      },
    }),
  );

  registry.register(
    defineTool({
      name: 'hafizaya_kaydet',
      description: 'Kullanici hakkinda kalici, sonradan hatirlanacak bir not kaydeder.',
      parameters: z.object({
        content: z.string().min(3).describe('kaydedilecek not'),
        sensitivity: z
          .enum(['public', 'personal', 'secret'])
          .optional()
          .describe('gizlilik sinifi'),
      }),
      execute: async (input, ctx) => {
        const scope = ctx.scope;
        if (isSystemScope(scope)) return { error: 'workspace scope gerekli' };
        requireRole(scope, 'member');
        ctx.signal?.throwIfAborted();
        const sourceId = memorySourceId('agent', input.content);
        if (contextExcluded({ sourceId, content: input.content })) {
          return { ok: true, sourceId, excluded: true };
        }
        const write = prepareMemoryWrite(input.content, input.sensitivity);
        const embedding = await deps.embedder.embed(write.embeddingText, { signal: ctx.signal });
        ctx.signal?.throwIfAborted();
        await withScope(deps.db.prisma, scope, async (tx) => {
          // withScope'un RLS set_config await'i sirasinda da abort gelebilir.
          // Kalici yazimin hemen onunde yeniden kontrol et.
          ctx.signal?.throwIfAborted();
          await upsertMemory(tx, scope, {
            sourceType: 'note',
            sourceId,
            content: input.content,
            embedding,
            sensitivity: write.sensitivity,
          });
        });
        return { ok: true, sourceId };
      },
    }),
  );

  registry.register(
    defineTool({
      name: 'cihazlarim',
      description:
        'Kullanicinin kayitli cihazlarini listeler: yuzey (surface), ad ve en son gorulme zamani.',
      parameters: z.object({}),
      execute: async (_input, ctx) => {
        const scope = ctx.scope;
        if (isSystemScope(scope)) return { error: 'workspace scope gerekli' };
        const devices = await withScope(deps.db.prisma, scope, (tx) => listDevices(tx, scope));
        return {
          devices: devices.map((d) => ({
            surface: d.surface,
            name: d.name,
            sonGorulme: d.lastSeenAt.toISOString(),
          })),
        };
      },
    }),
  );

  // DEVICE-LOCUS: gateway YURUTMEZ; tool-loop `tool_call` frame'i olarak bagli
  // istemciye (cihaza) yollar, sonucu `tool_result` ile alir (device-bridge).
  // `cihaz_bilgisi` SALT-OKUR sistem bilgisidir → sandbox gerektirmez. Kabuk/
  // dosya gibi keyfi-exec device araclari Faz 3 sandbox gelene kadar EKLENMEZ.
  registry.register(
    defineTool({
      name: 'cihaz_bilgisi',
      description:
        'Bagli cihazin ANLIK sistem bilgisi (isletim sistemi, host adi, calisma suresi, CPU/RAM). Istemcide calisir; salt-okur.',
      parameters: z.object({}),
      locus: 'device',
    }),
  );

  return registry;
}

/** Icerik-tabanli idempotency icin collision'a dayanikli, kararli kimlik. */
export function memorySourceId(prefix: 'agent' | 'voice', content: string): string {
  return `${prefix}:${createHash('sha256').update(content).digest('base64url')}`;
}

type MemorySensitivity = 'public' | 'personal' | 'secret';

/**
 * Hafizaya YAZILACAK icerigin embedding girdisi ve gizlilik sinifi. Kullanici
 * icerigi ACIKCA kaydettirdigi icin yerel DB'ye TAM metin yazilir, ama uzak
 * embedding saglayicisina yalniz maskeli metin gider; maskeleme bir sir
 * bulduysa kayit `secret` olur (ADR 0004: secret Live/bulut modele donmez) ve
 * yalniz sirdan ibaret icerik de tutulur (vektoru maskeli metinden uretilir).
 */
export function prepareMemoryWrite(
  content: string,
  requested?: MemorySensitivity,
): { embeddingText: string; sensitivity: MemorySensitivity } {
  const redacted = redactSecrets(content);
  return {
    embeddingText: redacted.text,
    sensitivity: redacted.found ? 'secret' : (requested ?? 'personal'),
  };
}
