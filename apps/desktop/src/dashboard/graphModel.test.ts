import { describe, expect, it } from 'vitest';
import type { MemoryRecord, VaultGraph } from './api.js';
import { buildGraph, radiusFor, vaultNodePath } from './graphModel.js';

describe('vault node paths', () => {
  it('joins Windows and POSIX roots without changing note names', () => {
    expect(vaultNodePath('C:\\vault\\', 'personal/My note.md')).toBe(
      'C:\\vault\\personal\\My note.md',
    );
    expect(vaultNodePath('/vault/', 'personal/My note.md')).toBe('/vault/personal/My note.md');
  });
  it.each(['../private', '/private', 'C:/private', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\u0000b'])(
    'rejects ambiguous node ID %s',
    (id) => {
      expect(vaultNodePath('/vault', id)).toBeUndefined();
    },
  );
  it('keeps the file link and finite deterministic node positions', () => {
    const graph = {
      root: '/vault',
      nodes: [{ id: 'a.md', label: 'A', vault: 'personal', size: 1 }],
      edges: [],
    };
    const first = buildGraph(graph, []);
    expect(first).toEqual(buildGraph(graph, []));
    expect(first.nodes[0]?.path).toBe('/vault/a.md');
    expect(Number.isFinite(first.nodes[0]?.x)).toBe(true);
  });
});

const note = (id: string) => ({ id, label: id, vault: 'v', size: 1 });
const record = (id: string, sourceType: string, sourceId: string): MemoryRecord => ({
  id,
  content: `kayit ${id}`,
  sourceType,
  sourceId,
  sensitivity: 'normal',
  createdAt: '2026-10-03T10:00:00.000Z',
});

describe('kenar insasi', () => {
  const vault: VaultGraph = {
    root: '/vault',
    nodes: [note('v/a.md'), note('v/b.md'), note('v/c.md')],
    edges: [
      { from: 'v/a.md', to: 'v/b.md' },
      { from: 'v/b.md', to: 'v/a.md' }, // karsilikli link: tek cizgi
      { from: 'v/a.md', to: 'v/b.md' }, // ayni linkin ikinci gecisi
      { from: 'v/c.md', to: 'v/c.md' }, // kendine link
      { from: 'v/a.md', to: 'v/yok.md' }, // olmayan hedef
    ],
  };

  it('tekrar eden, karsilikli ve kendine donen kenarlari tek cizgiye indirir', () => {
    const sim = buildGraph(vault, []);
    expect(sim.edges).toEqual([{ a: 0, b: 1 }]);
    expect(sim.links).toHaveLength(1);
  });

  it('hafiza kaydi hub ve (varsa) vault notu ile baglanir, ayni nota giden ikinci kayit ayri kenardir', () => {
    const sim = buildGraph(vault, [
      record('1', 'obsidian', 'obsidian:v/a.md'),
      record('2', 'obsidian', 'obsidian:v/a.md'),
      record('3', 'github', 'github:x'),
    ]);
    const ids = (index: number) => sim.nodes[index]?.id;
    const pairs = sim.edges.map((edge) => [ids(edge.a), ids(edge.b)].join(' - '));
    expect(pairs).toContain('m:1 - h:obsidian');
    expect(pairs).toContain('m:1 - v:v/a.md');
    expect(pairs).toContain('m:2 - v:v/a.md');
    expect(pairs).toContain('m:3 - h:github');
    expect(pairs).toHaveLength(1 + 2 + 2 + 1);
  });

  it('bos girdide bos ama gecerli (oturmus) bir graf doner', () => {
    const sim = buildGraph(null, []);
    expect(sim.nodes).toEqual([]);
    expect(sim.edges).toEqual([]);
    expect(sim.alpha).toBe(0);
  });
});

describe('dugum gorunumu', () => {
  it('yaricap baglanti sayisiyla buyur ve tavanda durur', () => {
    expect(radiusFor('note', 1)).toBeGreaterThan(radiusFor('note', 0));
    expect(radiusFor('note', 9)).toBeGreaterThan(radiusFor('note', 4));
    expect(radiusFor('note', 100000)).toBe(radiusFor('note', 200000));
    expect(radiusFor('hub', 100)).toBeGreaterThan(radiusFor('note', 4));
    expect(radiusFor('hub', 1)).toBeGreaterThan(radiusFor('mem', 1));
  });

  it('buildGraph yaricapi derece ile atar (hub ve cok linkli not buyuk, yetim kucuk)', () => {
    const vault: VaultGraph = {
      root: '/vault',
      nodes: [note('v/hub.md'), note('v/a.md'), note('v/b.md'), note('v/c.md'), note('v/yetim.md')],
      edges: [
        { from: 'v/hub.md', to: 'v/a.md' },
        { from: 'v/hub.md', to: 'v/b.md' },
        { from: 'v/hub.md', to: 'v/c.md' },
      ],
    };
    const sim = buildGraph(vault, []);
    const radius = (id: string) => sim.nodes.find((node) => node.id === id)?.r ?? 0;
    expect(radius('v:v/hub.md')).toBeGreaterThan(radius('v:v/a.md'));
    expect(radius('v:v/a.md')).toBeGreaterThan(radius('v:v/yetim.md'));
  });
});

describe('ilk cizimde oturmus yerlesim', () => {
  const vault: VaultGraph = {
    root: '/vault',
    nodes: Array.from({ length: 40 }, (_, i) => note(`v/n${i}.md`)),
    edges: Array.from({ length: 30 }, (_, i) => ({
      from: `v/n${i}.md`,
      to: `v/n${(i * 7 + 1) % 30}.md`,
    })),
  };

  it('buildGraph donerken motor sogumus ve konumlar sonlu (animasyon gerekmez)', () => {
    const sim = buildGraph(vault, [record('1', 'github', 'github:x')]);
    expect(sim.alpha).toBe(0);
    for (const node of sim.nodes) {
      expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
    }
  });

  it('ayni veri her seferinde ayni sekli verir', () => {
    const positions = (graph: VaultGraph) =>
      buildGraph(graph, []).nodes.map((node) => [node.x, node.y]);
    expect(positions(vault)).toEqual(positions(vault));
  });
});
