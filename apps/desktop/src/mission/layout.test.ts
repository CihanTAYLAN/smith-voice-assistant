import { describe, expect, it } from 'vitest';

import type { Agent, Board, Task } from './api.js';
import {
  agentStatusLabel,
  authorLabel,
  buildOrg,
  createRequestGate,
  ellipsize,
  flattenOrg,
  formatCost,
  groupByStatus,
  isBoardEmpty,
  layoutOrg,
  ORG,
  relativeAgo,
  relativeTime,
  sumCost,
  sumTodayCost,
  surfaceOf,
} from './layout.js';

function agent(id: string, slug: string, parentId: string | null = null, role = 'kod'): Agent {
  return {
    id,
    slug,
    displayName: slug.toUpperCase(),
    role,
    soul: 'x',
    model: null,
    parentId,
    device: 'wsl',
    workRoots: [],
    allowedTools: [],
    status: 'idle',
    lastSeenAt: null,
  };
}

function task(id: string, status: string, priority = 2, updatedAt = '2026-08-17T10:00:00Z'): Task {
  return {
    id,
    title: id,
    detail: null,
    status,
    priority,
    assigneeId: null,
    deliverable: null,
    artifactPath: null,
    createdBy: 'smith',
    dueAt: null,
    startedAt: null,
    finishedAt: null,
    updatedAt,
  };
}

describe('org semasi', () => {
  it('ust-ast iliskisini agaca cevirir ve derinlik verir', () => {
    const roots = buildOrg([agent('a', 'lead'), agent('b', 'nova', 'a'), agent('c', 'atlas', 'b')]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.agent.slug).toBe('lead');
    expect(roots[0]?.children[0]?.agent.slug).toBe('nova');
    expect(roots[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it('silinmis uste bagli ajani KAYBETMEZ, kok yapar', () => {
    const roots = buildOrg([agent('b', 'nova', 'yok-artik')]);
    expect(roots.map((r) => r.agent.slug)).toEqual(['nova']);
  });

  it('dongude sonsuza gitmez', () => {
    // a→b→a: sunucu kendi ustu olmayi reddediyor ama uzun zincir hala kurulabilir.
    const roots = buildOrg([agent('a', 'bir', 'b'), agent('b', 'iki', 'a')]);
    expect(flattenOrg(roots)).toHaveLength(2);
  });

  it('her ajan agacta TAM BIR KEZ gorunur', () => {
    const flat = flattenOrg(
      buildOrg([agent('a', 'lead'), agent('b', 'nova', 'a'), agent('c', 'atlas', 'a')]),
    );
    expect(flat.map((n) => n.agent.slug).sort()).toEqual(['atlas', 'lead', 'nova']);
  });
});

describe('kanban gruplama', () => {
  it('gorevleri kendi kolonuna koyar', () => {
    const columns = groupByStatus([task('t1', 'inbox'), task('t2', 'review')]);
    expect(columns.inbox?.map((t) => t.id)).toEqual(['t1']);
    expect(columns.review?.map((t) => t.id)).toEqual(['t2']);
  });

  it('BILINMEYEN durumu yutmaz, engel kolonunda gosterir', () => {
    // Sunucu yeni bir durum eklerse gorev panodan kaybolmamali.
    const columns = groupByStatus([task('t9', 'arsivlendi')]);
    expect(columns.blocked?.map((t) => t.id)).toEqual(['t9']);
  });

  it('once oncelik, sonra en yeni hareket', () => {
    const columns = groupByStatus([
      task('dusuk', 'inbox', 3),
      task('yuksek', 'inbox', 1),
      task('eski-normal', 'inbox', 2, '2026-08-01T10:00:00Z'),
      task('yeni-normal', 'inbox', 2, '2026-08-16T10:00:00Z'),
    ]);
    expect(columns.inbox?.map((t) => t.id)).toEqual([
      'yuksek',
      'yeni-normal',
      'eski-normal',
      'dusuk',
    ]);
  });

  it('bos panoda tum kolonlar tanimlidir', () => {
    const columns = groupByStatus([]);
    expect(Object.keys(columns)).toHaveLength(6);
  });
});

describe('bicimleme', () => {
  it('maliyet micros -> USD', () => {
    expect(formatCost(1_234_500)).toBe('1.2345');
    expect(formatCost(0)).toBe('0.0000');
    expect(formatCost(null)).toBe('0.0000');
  });

  it('bagil zaman', () => {
    const now = Date.parse('2026-08-17T12:00:00Z');
    expect(relativeTime('2026-08-17T11:59:30Z', now)).toBe('30 sn');
    expect(relativeTime('2026-08-17T11:30:00Z', now)).toBe('30 dk');
    expect(relativeTime('2026-08-17T09:00:00Z', now)).toBe('3 sa');
    expect(relativeTime('2026-08-15T12:00:00Z', now)).toBe('2 gün');
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime('bozuk-tarih', now)).toBe('—');
  });

  it('bugunku maliyete yalniz yerel gun icindeki kosulari katar', () => {
    const now = new Date(2026, 9, 3, 15).getTime();
    const runs = [
      { startedAt: new Date(2026, 9, 3, 1).toISOString(), costMicros: 1_250_000 },
      { startedAt: new Date(2026, 9, 2, 23).toISOString(), costMicros: 9_000_000 },
      { startedAt: 'bozuk', costMicros: 5_000_000 },
    ];
    expect(sumTodayCost(runs, now)).toBe(1_250_000);
  });
});

describe('istek kapisi', () => {
  it('eski cevabin yeni veriyi ezmesini engeller', () => {
    const gate = createRequestGate();
    const oldRequest = gate.next();
    const newestRequest = gate.next();
    expect(gate.isCurrent(oldRequest)).toBe(false);
    expect(gate.isCurrent(newestRequest)).toBe(true);
  });

  it('invalidate bekleyen cevabi gecersiz kilar', () => {
    const gate = createRequestGate();
    const request = gate.next();
    gate.invalidate();
    expect(gate.isCurrent(request)).toBe(false);
  });
});

describe('org semasi yerlesimi', () => {
  const chain = [agent('a', 'lead'), agent('b', 'nova', 'a'), agent('c', 'atlas', 'b')];

  it('derinlik yatayda kucuk girinti olur; ucuncu seviye de dar panele sigar', () => {
    const { nodes, width } = layoutOrg(chain);
    expect(nodes.map((node) => node.x)).toEqual([
      ORG.pad,
      ORG.pad + ORG.indent,
      ORG.pad + 2 * ORG.indent,
    ]);
    // Eski yerlesim her seviyeye 188 px ayirip 3 seviyede 588 px'e cikiyor ve 250 px'lik panelde kesiliyordu.
    expect(width).toBe(ORG.pad * 2 + ORG.nodeWidth + 2 * ORG.indent);
    expect(width).toBeLessThanOrEqual(260);
  });

  it('hicbir kutu cizim alaninin disina tasmaz', () => {
    const deep = Array.from({ length: 6 }, (_, i) =>
      agent(String(i), 'a' + i, i === 0 ? null : String(i - 1)),
    );
    const { height, nodes, width } = layoutOrg(deep);
    for (const node of nodes) {
      expect(node.x + ORG.nodeWidth).toBeLessThanOrEqual(width);
      expect(node.y + ORG.nodeHeight).toBeLessThanOrEqual(height);
    }
  });

  it('satirlar agac sirasinda ust uste dizilir ve her ast icin bir baglanti cizgisi vardir', () => {
    const { edges, nodes } = layoutOrg(chain);
    expect(nodes.map((node) => node.y)).toEqual([
      ORG.pad,
      ORG.pad + ORG.row,
      ORG.pad + 2 * ORG.row,
    ]);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({
      key: 'a-b',
      path: `M ${ORG.pad + 14} ${ORG.pad + ORG.nodeHeight} V ${ORG.pad + ORG.row + ORG.nodeHeight / 2} H ${ORG.pad + ORG.indent}`,
    });
  });

  it('dongulu veri de her ajani bir kez cizer', () => {
    const { nodes } = layoutOrg([agent('a', 'bir', 'b'), agent('b', 'iki', 'a')]);
    expect(nodes).toHaveLength(2);
  });
});

describe('kullanici metni yardimcilari', () => {
  it('uzun metni kisaltir, kisayi dokunmadan birakir', () => {
    expect(ellipsize('nova', 17)).toBe('nova');
    expect(ellipsize('Araştırma ve geliştirme · windows', 23)).toBe('Araştırma ve geliştirm…');
    expect(ellipsize('abc  defgh', 5)).toBe('abc…');
    expect(ellipsize('abc', 1)).toBe('…');
  });

  it('ajan durumunu Turkce gosterir, bilinmeyeni oldugu gibi birakir', () => {
    expect(agentStatusLabel('idle')).toBe('Boşta');
    expect(agentStatusLabel('working')).toBe('Çalışıyor');
    expect(agentStatusLabel('offline')).toBe('Devre dışı');
    expect(agentStatusLabel('yeni-durum')).toBe('yeni-durum');
  });

  it('yorum yazarini gosterir', () => {
    const slugOf = new Map([['a1', 'nova']]);
    expect(authorLabel('agent', 'a1', slugOf)).toBe('@nova');
    expect(authorLabel('agent', 'silinmis', slugOf)).toBe('@ajan');
    expect(authorLabel('user', 'cihan', slugOf)).toBe('Sen');
    expect(authorLabel('system', 'x', slugOf)).toBe('Sistem');
    expect(authorLabel('baska', 'x', slugOf)).toBe('baska');
  });

  it('"X once" metni uretir, zaman yoksa bilinmiyor der', () => {
    const now = Date.parse('2026-08-17T12:00:00Z');
    expect(relativeAgo('2026-08-17T11:30:00Z', now)).toBe('30 dk önce');
    expect(relativeAgo(null, now)).toBe('bilinmiyor');
    expect(relativeAgo('bozuk', now)).toBe('bilinmiyor');
  });
});

describe('maliyet ve yuzey durumu', () => {
  it('toplam maliyet bos ve null degerleri sifir sayar', () => {
    expect(sumCost([])).toBe(0);
    expect(
      sumCost([{ costMicros: 1_000_000 }, { costMicros: null }, { costMicros: 250_000 }]),
    ).toBe(1_250_000);
  });

  it('pano yalniz ekip, gorev ve olay HEPSI bossa bostur', () => {
    const base: Board = { agents: [], tasks: [], events: [], transitions: {} };
    expect(isBoardEmpty(base)).toBe(true);
    expect(isBoardEmpty({ ...base, agents: [agent('a', 'nova')] })).toBe(false);
    expect(isBoardEmpty({ ...base, tasks: [task('t', 'inbox')] })).toBe(false);
  });

  it('veri gelmisse bos/hazir ayrimini alt yuzey belirler; digerleri aynen gecer', () => {
    expect(surfaceOf('ready', true)).toBe('empty');
    expect(surfaceOf('empty', false)).toBe('ready');
    expect(surfaceOf('loading', true)).toBe('loading');
    expect(surfaceOf('error', true)).toBe('error');
    expect(surfaceOf('stale', true)).toBe('stale');
  });
});
