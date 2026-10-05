import type { MemoryRecord, VaultGraph, VaultNode } from './api.js';

/**
 * SENTETIK BILGI GRAFI (yalniz test + gorsel olcum icin): gercek kullanimin
 * bicimini taklit eder, ama tohumludur; her cagrida ayni veri uretilir.
 *
 *  - Vault: 3 kasa; notlarin ~%18'i yetim (kenarsiz), ~%12'si 2-4'luk adacik,
 *    kalani tercihli baglanmayla (hub'li) tek govde; az sayida kasalar arasi link.
 *  - Hafiza: kaynak turune gore hub'a bagli kayitlar; `obsidian` kayitlari
 *    govdedeki bir nota da baglanir (hub - kayit - not zinciri).
 */

export interface Fixture {
  vault: VaultGraph;
  records: MemoryRecord[];
}

const VAULTS = ['personal', 'projects', 'archive'] as const;
const FOLDERS = ['inbox', 'daily', 'notes', 'refs'] as const;
const SOURCES: readonly (readonly [string, number])[] = [
  ['obsidian', 0.45],
  ['github', 0.26],
  ['conversation', 0.17],
  ['manual', 0.12],
];

const ORPHAN_SHARE = 0.18;
const ISLAND_SHARE = 0.12;
const CROSS_VAULT_SHARE = 0.1;

/** Tohumlu PRNG (mulberry32): test verisi oturumlar arasi ayni kalsin. */
function seeded(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticKnowledge(noteCount = 800, memoryCount = 300, seed = 7): Fixture {
  const rand = seeded(seed);
  const pick = (count: number): number => Math.floor(rand() * count);

  const nodes: VaultNode[] = [];
  for (let i = 0; i < noteCount; i++) {
    const vault = VAULTS[rand() < 0.35 ? 0 : rand() < 0.7 ? 1 : 2] ?? 'personal';
    const folder = FOLDERS[pick(FOLDERS.length)] ?? 'inbox';
    nodes.push({
      id: `${vault}/${folder}/n${String(i).padStart(4, '0')}.md`,
      label: `n${String(i).padStart(4, '0')}.md`,
      vault,
      size: 200 + pick(4000),
    });
  }

  const edges: { from: string; to: string }[] = [];
  const link = (a: number, b: number): void => {
    const from = nodes[a]?.id;
    const to = nodes[b]?.id;
    if (from !== undefined && to !== undefined && a !== b) edges.push({ from, to });
  };

  const orphanEnd = Math.floor(noteCount * ORPHAN_SHARE);
  const islandEnd = orphanEnd + Math.floor(noteCount * ISLAND_SHARE);
  // Adacik: ardisik 2-4 not, zincir olarak baglanir.
  for (let i = orphanEnd; i < islandEnd;) {
    const size = Math.min(2 + pick(3), islandEnd - i);
    for (let k = 1; k < size; k++) link(i + k - 1, i + k);
    i += size;
  }
  // Govde: tercihli baglanma (kenar uclarindan rastgele secim = derece orantili).
  const ends: number[] = [islandEnd];
  for (let i = islandEnd + 1; i < noteCount; i++) {
    const wanted = 1 + pick(3);
    for (let k = 0; k < wanted; k++) {
      const sameVault = rand() >= CROSS_VAULT_SHARE;
      let target = ends[pick(ends.length)] ?? islandEnd;
      for (let tries = 0; sameVault && tries < 8; tries++) {
        if (nodes[target]?.vault === nodes[i]?.vault) break;
        target = ends[pick(ends.length)] ?? islandEnd;
      }
      link(i, target);
      ends.push(i, target);
    }
  }

  const bodyStart = islandEnd;
  const records: MemoryRecord[] = [];
  for (let i = 0; i < memoryCount; i++) {
    const roll = rand();
    let acc = 0;
    let source = 'manual';
    for (const [name, share] of SOURCES) {
      acc += share;
      if (roll < acc) {
        source = name;
        break;
      }
    }
    const note = nodes[bodyStart + pick(Math.max(1, noteCount - bodyStart))];
    records.push({
      id: `mem-${String(i).padStart(4, '0')}`,
      content: `Kayit ${i} (${source})`,
      sourceType: source,
      sourceId: source === 'obsidian' && note ? `obsidian:${note.id}` : `${source}:${i}`,
      sensitivity: 'normal',
      createdAt: '2026-10-03T10:00:00.000Z',
    });
  }

  return { vault: { root: '/vault', nodes, edges }, records };
}
