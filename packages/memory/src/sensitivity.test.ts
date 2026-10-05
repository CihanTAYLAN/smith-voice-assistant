import { describe, expect, it, vi } from 'vitest';

import { searchMemories } from './repo.js';

/**
 * GIZLILIK KAPISI TESTI.
 *
 * 2026-08-15 denetiminde bulunan kusur: `searchMemories`'in varsayilani
 * `['public','personal','secret']` idi ve `apps/gateway/src/turn.ts` bu
 * parametreyi HIC vermiyordu. Yani sohbet turu recall'i gizli hafizalari
 * modele — dolayisiyla bulut saglayicisina — enjekte etmeye haziridi. Zarar
 * gormememizin tek sebebi veritabaninda henuz `secret` kayit olmamasiydi; bu
 * bir ZAMANLAMA sansi, tasarim degil.
 *
 * Bu testler iki seyi birden kapiya baglar:
 *  1. Varsayilan FAIL-CLOSED: parametre unutulursa `secret` DISLANIR.
 *  2. Filtre gercekten SQL'e gider (yalniz TS tarafinda suzulup gecmiyor).
 *
 * Not: burada `secret`'i acikca istemenin hala mumkun oldugu da sabitlenir —
 * amac yetenegi kaldirmak degil, VARSAYILANI guvenli yapmak.
 */

/** `$queryRaw` cagrisini yakalayan sahte transaction. */
function sahteTx(): { tx: { $queryRaw: ReturnType<typeof vi.fn> }; params: unknown[][] } {
  const params: unknown[][] = [];
  const $queryRaw = vi.fn((_strings: TemplateStringsArray, ...args: unknown[]) => {
    params.push(args);
    return Promise.resolve([]);
  });
  return { tx: { $queryRaw }, params };
}

const scope = { workspaceId: 'ws_x', actorId: 'act_x' } as never;

describe('hafiza geri getirme hassasiyet filtresi', () => {
  it('VARSAYILAN fail-closed: parametre verilmezse secret DISLANIR', async () => {
    const { tx, params } = sahteTx();
    await searchMemories(tx as never, scope, [0.1, 0.2], {});
    const gonderilen = params.flat().find((p) => Array.isArray(p)) as string[] | undefined;
    expect(gonderilen, 'hassasiyet listesi SQL parametresi olarak gitmeli').toBeDefined();
    expect(gonderilen).toEqual(['public', 'personal']);
    expect(gonderilen).not.toContain('secret');
  });

  it('secret ACIKCA istenebilir (yetenek kaldirilmadi)', async () => {
    const { tx, params } = sahteTx();
    await searchMemories(tx as never, scope, [0.1], {
      allowedSensitivity: ['public', 'personal', 'secret'],
    });
    const gonderilen = params.flat().find((p) => Array.isArray(p)) as string[] | undefined;
    expect(gonderilen).toContain('secret');
  });

  it('filtre SQL parametresine girer — TS tarafinda suzulmez', async () => {
    const { tx, params } = sahteTx();
    await searchMemories(tx as never, scope, [0.1], { allowedSensitivity: ['public'] });
    // Sorgu HIC cagrilmadan bos donduruluyorsa filtre veritabanina gitmiyordur.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(params.flat()).toContainEqual(['public']);
  });
});
