import { createWorkspaceScope } from '@smith/tenancy';
import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '../scoped.js';

import { listSessionMessages } from './messages.js';

const WS = 'ws_00000000000000000000';
const ACTOR = 'act_00000000000000000000';
const SESSION = 'ses_00000000000000000000';
const owner = createWorkspaceScope({ workspaceId: WS, actorId: ACTOR, role: 'owner' });

/** Veritabani sirasini taklit eder: verilen orderBy'a gore siralayip `take` kadar keser. */
function fakeTx(rows: { id: string; createdAt: Date; text: string }[]) {
  const findMany = vi.fn(
    (args: {
      orderBy:
        { createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }[] | { createdAt: 'asc' | 'desc' };
      take: number;
    }) => {
      const order = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
      const sorted = [...rows].sort((a, b) => {
        for (const rule of order) {
          const direction = (rule.createdAt ?? rule.id) === 'desc' ? -1 : 1;
          const left = rule.createdAt ? a.createdAt.getTime() : a.id;
          const right = rule.createdAt ? b.createdAt.getTime() : b.id;
          if (left < right) return -1 * direction;
          if (left > right) return 1 * direction;
        }
        return 0;
      });
      return Promise.resolve(sorted.slice(0, args.take));
    },
  );
  return { tx: { message: { findMany } } as unknown as Tx, findMany };
}

const message = (index: number) => ({
  id: `msg_${index.toString().padStart(20, '0')}`,
  createdAt: new Date(1_000_000 + index * 1_000),
  text: `mesaj-${index}`,
});

describe('listSessionMessages', () => {
  it('uzun oturumda EN YENI N mesaji dondurur (eskiler degil), eski->yeni sirayla', async () => {
    // Canlida 241 mesajli oturum var; ozet 200 sinirinda son mesajlari gormeli.
    const rows = Array.from({ length: 241 }, (_unused, index) => message(index));
    const { tx } = fakeTx(rows);

    const result = await listSessionMessages(tx, owner, SESSION, 200);

    expect(result).toHaveLength(200);
    expect(result[0]?.text).toBe('mesaj-41');
    expect(result.at(-1)?.text).toBe('mesaj-240');
    expect(result.map((row) => row.createdAt.getTime())).toEqual(
      [...result.map((row) => row.createdAt.getTime())].sort((a, b) => a - b),
    );
  });

  it('sinirdan kisa oturumda hepsini kronolojik dondurur', async () => {
    const { tx } = fakeTx([message(2), message(0), message(1)]);

    const result = await listSessionMessages(tx, owner, SESSION);

    expect(result.map((row) => row.text)).toEqual(['mesaj-0', 'mesaj-1', 'mesaj-2']);
  });

  it('ayni createdAt degerinde id ile deterministik siralar', async () => {
    const sameMoment = new Date(5_000_000);
    const rows = [
      { id: 'msg_00000000000000000003', createdAt: sameMoment, text: 'ucuncu' },
      { id: 'msg_00000000000000000001', createdAt: sameMoment, text: 'birinci' },
      { id: 'msg_00000000000000000002', createdAt: sameMoment, text: 'ikinci' },
    ];
    const { tx } = fakeTx(rows);

    const result = await listSessionMessages(tx, owner, SESSION, 2);

    expect(result.map((row) => row.text)).toEqual(['ikinci', 'ucuncu']);
  });

  it('sorguyu workspace ve oturumla kisitlar, varsayilan sinir 50', async () => {
    const { tx, findMany } = fakeTx([]);

    await listSessionMessages(tx, owner, SESSION);

    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, sessionId: SESSION },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
  });
});
