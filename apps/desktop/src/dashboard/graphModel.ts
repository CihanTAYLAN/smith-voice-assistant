import type { MemoryRecord, VaultGraph } from './api.js';
import { createLayout, degreesOf, warmUp } from './graphLayout.js';

/**
 * BILGI GRAFIGI MODELI: vektor hafiza + vault, tek kuvvet simulasyonunda.
 *
 * VERI IKI KAYNAKTAN (ikisi de SALT OKUMA):
 *  - Vault: Rust `dashboard_vault_graph` → ObsidianVaults altindaki .md
 *    dosyalari + [[wiki]] ve markdown linklerinden kenarlar.
 *  - Hafiza: gateway `/v1/tools/memory/list` (mission_call kopruSU, yalniz
 *    okuma uclari). `obsidian:` sourceId'si vault dugumune BAGLANIR, yani
 *    "hangi not hafizada" iliskisi grafikte gorunur; diger kaynaklar kendi
 *    sourceType hub'ina baglanir.
 *
 * MOTOR: kendi kuvvet simulasyonumuz (`graphLayout.ts`, Barnes-Hut); d3 gibi
 * bagimlilik YOKTUR ("zengin ama hafif" ilkesi). Konumlar tohumlu
 * (deterministik); pencere yeniden acilinca yerlesim ayni kalir. `buildGraph`
 * yerlesimi ilk cizimden ONCE oturtur (on-isitma): grafik ucarak acilmaz.
 */

export interface GNode {
  id: string;
  label: string;
  kind: 'note' | 'mem' | 'hub';
  color: string;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Surukleme sirasinda sabit dunya konumu; undefined ise dugum serbesttir. */
  fx?: number | undefined;
  fy?: number | undefined;
  path?: string | undefined;
  record?: MemoryRecord;
}

export interface GEdge {
  a: number;
  b: number;
}

/** Cizilebilir graf: kamera ve cizim yalniz bunu bilir. */
export interface Sim {
  nodes: GNode[];
  edges: GEdge[];
}

/** Yay terimi: kenar basina bir kez hesaplanir (guc ve yanlilik dereceden gelir). */
export interface Link {
  a: GNode;
  b: GNode;
  rest: number;
  strength: number;
  bias: number;
}

/** Yerlesim motorunun durumu: yaylar ve sogutma (alpha 1 -> hedef; 0 = oturdu). */
export interface LayoutSim extends Sim {
  links: Link[];
  /** Dugum basina merkez cekimi gucu (nodes ile ayni sira). */
  gravity: number[];
  alpha: number;
  alphaTarget: number;
}

const PALETTE = [
  '#43e6ff',
  '#ff5cf0',
  '#8b5cff',
  '#ffb454',
  '#7ee787',
  '#ff6b8a',
  '#9be8ff',
  '#f2d16b',
];

/** Anahtar → palet rengi (deterministik; hash tabanli). */
function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length] ?? '#8b5cff';
}

/** Tur basina yaricap: taban + baglanti sayisinin karekoku (hub buyur), tavanli. */
const RADIUS: Record<GNode['kind'], { base: number; grow: number; max: number }> = {
  note: { base: 2.2, grow: 0.7, max: 6.5 },
  mem: { base: 1.8, grow: 0.4, max: 3 },
  hub: { base: 4.5, grow: 0.4, max: 10 },
};

export function radiusFor(kind: GNode['kind'], degree: number): number {
  const { base, grow, max } = RADIUS[kind];
  return Math.min(max, base + grow * Math.sqrt(degree));
}

const hasControlChar = (text: string): boolean => [...text].some((char) => char.charCodeAt(0) < 32);

/** Dugum kimligi `vault/klasor/not.md` bicimindedir; ust dizin, mutlak yol ve surucu harfi tasiyamaz. */
const isSafeSegment = (part: string): boolean =>
  part !== '' && part !== '.' && part !== '..' && !/[\\:]/.test(part) && !hasControlChar(part);

/**
 * Vault dugumunun diskteki yolu: kok + kimlik, kokun ayiracini (\ veya /)
 * koruyarak. Belirsiz kimlik (`..`, mutlak, bos parca) yol DEGIL `undefined`
 * uretir; "Dosyalar'da ac" yalniz guvenle cozulen yollara baglanir.
 */
export function vaultNodePath(root: string, id: string): string | undefined {
  const parts = id.split('/');
  if (!root || !parts.every(isSafeSegment)) return undefined;
  const separator = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]$/, '') + separator + parts.join(separator);
}

/** Cift anahtari icin carpan: dugum indeksleri bunun altinda kalir. */
const EDGE_KEY_STRIDE = 1 << 24;

/**
 * Kenar ekler; kendine donen ve tekrar eden (A->B, B->A ya da ayni linkin
 * ikinci gecisi) kenarlar atilir: ikisi de cizimi yogunlastirir, derece ve yay
 * gucunu sisirirdi (gercek vault'ta kenarlarin ~%36'si tekrardi).
 */
function addEdge(edges: GEdge[], seen: Set<number>, a: number, b: number): void {
  const key = Math.min(a, b) * EDGE_KEY_STRIDE + Math.max(a, b);
  if (a === b || seen.has(key)) return;
  seen.add(key);
  edges.push({ a, b });
}

export function buildGraph(vault: VaultGraph | null, records: MemoryRecord[]): LayoutSim {
  // --- dugum/kenar insasi -------------------------------------------------
  const nodes: GNode[] = [];
  const index = new Map<string, number>();
  const edges: GEdge[] = [];
  const seenEdges = new Set<number>();

  const vaultNodes = vault?.nodes ?? [];
  for (const v of vaultNodes) {
    index.set(`v:${v.id}`, nodes.length);
    nodes.push({
      id: `v:${v.id}`,
      label: v.label,
      kind: 'note',
      path: vault ? vaultNodePath(vault.root, v.id) : undefined,
      color: colorFor(v.vault),
      r: radiusFor('note', 0),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    });
  }
  for (const e of vault?.edges ?? []) {
    const a = index.get(`v:${e.from}`);
    const b = index.get(`v:${e.to}`);
    if (a !== undefined && b !== undefined) addEdge(edges, seenEdges, a, b);
  }

  const hubs = new Map<string, number>();
  for (const r of records) {
    let hub = hubs.get(r.sourceType);
    if (hub === undefined) {
      hub = nodes.length;
      hubs.set(r.sourceType, hub);
      index.set(`h:${r.sourceType}`, hub);
      nodes.push({
        id: `h:${r.sourceType}`,
        label: r.sourceType,
        kind: 'hub',
        color: colorFor(`hub:${r.sourceType}`),
        r: radiusFor('hub', 0),
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
      });
    }
    const memIdx = nodes.length;
    index.set(`m:${r.id}`, memIdx);
    nodes.push({
      id: `m:${r.id}`,
      label: r.sourceType,
      kind: 'mem',
      color: colorFor(`hub:${r.sourceType}`),
      r: radiusFor('mem', 0),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      record: r,
    });
    addEdge(edges, seenEdges, memIdx, hub);
    // obsidian kaydi → vault notu (sourceId: "obsidian:<vault>/<relpath>")
    if (r.sourceType === 'obsidian' && r.sourceId.startsWith('obsidian:')) {
      const rel = r.sourceId.slice('obsidian:'.length);
      const noteIdx = index.get(`v:${rel}`);
      if (noteIdx !== undefined) addEdge(edges, seenEdges, memIdx, noteIdx);
    }
  }

  // --- gorunum olcegi: yaricap baglanti sayisiyla buyur ----------------------
  const degree = degreesOf(nodes.length, edges);
  nodes.forEach((node, i) => {
    node.r = radiusFor(node.kind, degree[i] ?? 0);
  });

  // --- yerlesim: tohum konumlar + on-isitma (ilk cizim zaten oturmus) --------
  const sim = createLayout({ nodes, edges }, degree);
  warmUp(sim);
  return sim;
}
