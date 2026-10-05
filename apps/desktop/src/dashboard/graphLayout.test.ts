import { describe, expect, it } from 'vitest';

import type { VaultGraph } from './api.js';
import { syntheticKnowledge } from './graphFixture.js';
import {
  createLayout,
  degreesOf,
  FORCES,
  isSettled,
  pinNode,
  reheat,
  releaseNode,
  restart,
  seedPositions,
  simulate,
  warmUp,
} from './graphLayout.js';
import { buildGraph, type GEdge, type GNode, type LayoutSim } from './graphModel.js';
import { fitCamera, type Viewport } from './graphView.js';

/** Dashboard'un gercek grafik sahnesi: 1280x800 pencerede 800x665, 900x700 pencerede 533x565. */
const LARGE: Viewport = { width: 800, height: 665 };
const SMALL: Viewport = { width: 533, height: 565 };
const BOTH = { notes: true, memory: true };

function node(index: number, r = 3): GNode {
  return {
    id: `n${index}`,
    label: `n${index}`,
    kind: 'note',
    color: '#fff',
    r,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  };
}

/** Dogrudan motor testleri icin model katmani olmadan kurulan oturmamis (alpha 0) graf. */
function layoutOf(count: number, edges: GEdge[], r = 3): LayoutSim {
  const nodes = Array.from({ length: count }, (_, index) => node(index, r));
  return createLayout({ nodes, edges }, degreesOf(count, edges));
}

const snapshot = (sim: LayoutSim): number[][] => sim.nodes.map((n) => [n.x, n.y]);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

/** Olcut 1 ve 2'nin ekran uzayindaki olcumu: sigdirma kamerasi + ekran pikseli. */
function measure(sim: LayoutSim, view: Viewport) {
  const camera = fitCamera(sim, view, BOTH);
  const short = Math.min(view.width, view.height);
  const points = sim.nodes.map((n) => ({
    x: view.width / 2 + camera.tx + n.x * camera.scale,
    y: view.height / 2 + camera.ty + n.y * camera.scale,
    r: n.r * camera.scale,
  }));
  const fromCenter = points.map((p) => Math.hypot(p.x - view.width / 2, p.y - view.height / 2));
  const lengths = sim.edges.map(({ a, b }) => {
    const from = points[a];
    const to = points[b];
    return from && to ? Math.hypot(from.x - to.x, from.y - to.y) : 0;
  });
  return {
    scale: camera.scale,
    inCircle: fromCenter.filter((d) => d <= 0.4 * short).length / points.length,
    allInFrame: points.every(
      (p) =>
        p.x - p.r >= 0 && p.x + p.r <= view.width && p.y - p.r >= 0 && p.y + p.r <= view.height,
    ),
    medianEdge: percentile(lengths, 0.5) / short,
    longestEdges: percentile(lengths, 0.99) / short,
  };
}

function overlappingPairs(sim: LayoutSim): number {
  let count = 0;
  sim.nodes.forEach((a, i) => {
    for (const b of sim.nodes.slice(i + 1)) {
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) count++;
    }
  });
  return count;
}

// 800 not + 300 hafiza kaydi (kullanicinin ekran goruntusundeki boyut); bir kez kurulur.
let knowledge: LayoutSim | undefined;
const bigGraph = (): LayoutSim => {
  if (!knowledge) {
    const { vault, records } = syntheticKnowledge(800, 300);
    knowledge = buildGraph(vault, records);
  }
  return knowledge;
};

describe('tohum yerlesimi', () => {
  it('degreesOf kendine donen kenari saymaz', () => {
    expect(
      degreesOf(3, [
        { a: 0, b: 1 },
        { a: 1, b: 1 },
        { a: 1, b: 2 },
      ]),
    ).toEqual([1, 2, 1]);
  });

  it('konumlar sonlu, benzersiz ve ayni girdide ayni', () => {
    const edges = [
      { a: 0, b: 1 },
      { a: 1, b: 2 },
    ];
    const first = layoutOf(50, edges);
    const second = layoutOf(50, edges);
    expect(snapshot(first)).toEqual(snapshot(second));
    const keys = new Set(snapshot(first).map(([x, y]) => `${x},${y}`));
    expect(keys.size).toBe(50);
    for (const [x, y] of snapshot(first))
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });

  it('buyuk bilesen merkeze, yetimler dis halkaya yerlesir', () => {
    const chain = Array.from({ length: 29 }, (_, i) => ({ a: i, b: i + 1 }));
    const sim = layoutOf(40, chain); // 0..29 zincir, 30..39 yetim
    const radius = (n: GNode) => Math.hypot(n.x, n.y);
    const mean = (nodes: GNode[]) => nodes.reduce((sum, n) => sum + radius(n), 0) / nodes.length;
    expect(mean(sim.nodes.slice(0, 30))).toBeLessThan(mean(sim.nodes.slice(30)));
  });

  it('seedPositions hizlari sifirlar', () => {
    const sim = layoutOf(5, []);
    for (const n of sim.nodes) {
      n.vx = 9;
      n.vy = -9;
    }
    seedPositions(sim.nodes, sim.edges);
    expect(sim.nodes.every((n) => n.vx === 0 && n.vy === 0)).toBe(true);
  });
});

describe('sogutma ve durma', () => {
  it('createLayout motoru sogumus (alpha 0) birakir; isitilinca alpha 1', () => {
    const sim = layoutOf(10, [{ a: 0, b: 1 }]);
    expect(isSettled(sim)).toBe(true);
    reheat(sim);
    expect(sim.alpha).toBe(1);
    expect(isSettled(sim)).toBe(false);
  });

  it('isinmis motor en gec coolTicks + 1 adimda oturur ve sonra hicbir sey oynatmaz', () => {
    const sim = layoutOf(30, [
      { a: 0, b: 1 },
      { a: 1, b: 2 },
    ]);
    reheat(sim);
    simulate(sim, FORCES.coolTicks - 5);
    expect(isSettled(sim)).toBe(false);
    simulate(sim, 6);
    expect(isSettled(sim)).toBe(true);
    const frozen = snapshot(sim);
    simulate(sim, 50);
    expect(snapshot(sim)).toEqual(frozen);
  });

  it('simulate(Infinity) guvenlidir: sogutma sonludur', () => {
    const sim = layoutOf(30, [{ a: 0, b: 1 }]);
    reheat(sim);
    simulate(sim, Infinity);
    expect(sim.alpha).toBe(0);
  });

  it('bos ve tek dugumlu grafta calisir', () => {
    const empty = layoutOf(0, []);
    warmUp(empty);
    expect(empty.nodes).toEqual([]);
    const single = layoutOf(1, []);
    warmUp(single);
    expect(Number.isFinite(single.nodes[0]?.x)).toBe(true);
    expect(Math.hypot(single.nodes[0]?.x ?? 0, single.nodes[0]?.y ?? 0)).toBeLessThan(5);
  });
});

describe('dugum surukleme', () => {
  it('sabitlenmis dugum simulasyonda imlec konumunda kalir', () => {
    const sim = layoutOf(3, [{ a: 0, b: 1 }]);
    warmUp(sim);
    const dragged = sim.nodes[0];
    if (!dragged) throw new Error('suruklenecek dugum yok');

    pinNode(sim, dragged, 120, -80);
    simulate(sim, 40);

    expect([dragged.x, dragged.y]).toEqual([120, -80]);
    expect([dragged.vx, dragged.vy]).toEqual([0, 0]);
    expect(sim.alpha).toBeCloseTo(FORCES.dragAlphaTarget);
  });

  it('komsu suruklenen dugume dogru gider; uzak baglantisiz dugum belirgin daha az oynar', () => {
    const sim = layoutOf(3, [{ a: 0, b: 1 }]);
    warmUp(sim);
    const [dragged, neighbor, unrelated] = sim.nodes;
    if (!dragged || !neighbor || !unrelated) throw new Error('uc dugum bekleniyordu');
    const beforeNeighbor = { x: neighbor.x, y: neighbor.y };
    const beforeUnrelated = { x: unrelated.x, y: unrelated.y };
    const target = { x: dragged.x + 120, y: dragged.y };

    pinNode(sim, dragged, target.x, target.y);
    simulate(sim, 30);

    const neighborMove = Math.hypot(neighbor.x - beforeNeighbor.x, neighbor.y - beforeNeighbor.y);
    const unrelatedMove = Math.hypot(
      unrelated.x - beforeUnrelated.x,
      unrelated.y - beforeUnrelated.y,
    );
    expect(Math.hypot(neighbor.x - target.x, neighbor.y - target.y)).toBeLessThan(
      Math.hypot(beforeNeighbor.x - target.x, beforeNeighbor.y - target.y),
    );
    expect(neighborMove).toBeGreaterThan(unrelatedMove * 2);
  });

  it('birakilinca alpha esige iner; sonraki simulate konumlari degistirmez', () => {
    const sim = layoutOf(3, [{ a: 0, b: 1 }]);
    warmUp(sim);
    const dragged = sim.nodes[0];
    if (!dragged) throw new Error('suruklenecek dugum yok');
    pinNode(sim, dragged, dragged.x + 80, dragged.y);
    simulate(sim, 10);

    releaseNode(sim, dragged);
    simulate(sim, FORCES.coolTicks + 1);

    expect(isSettled(sim)).toBe(true);
    expect(sim.alpha).toBe(0);
    const frozen = snapshot(sim);
    simulate(sim, 50);
    expect(snapshot(sim)).toEqual(frozen);
  });
});

describe('kararlilik (eski motorun firlatma hatasi)', () => {
  it('ayni noktaya yigilmis 200 dugum sonsuza itilmez: sonlu kalir ve merkeze yakin toplanir', () => {
    // Eski 1/d^2 itme minimum mesafesizdi; yakin cift binlerce birim hiz alip sahne disina cikiyordu.
    const edges = Array.from({ length: 199 }, (_, i) => ({ a: 0, b: i + 1 }));
    const sim = layoutOf(200, edges);
    for (const n of sim.nodes) {
      n.x = 0;
      n.y = 0;
    }
    warmUp(sim);
    for (const n of sim.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    const farthest = Math.max(...sim.nodes.map((n) => Math.hypot(n.x, n.y)));
    expect(farthest).toBeLessThan(300);
    // Hepsi ayri bir konuma dagildi (jitter ile ayrilir, ust uste kalmaz).
    expect(new Set(sim.nodes.map((n) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`)).size).toBe(200);
  });

  it('cok yakin iki dugum birbirini sahne disina atmaz', () => {
    const sim = layoutOf(2, []);
    const [a, b] = sim.nodes;
    if (!a || !b) throw new Error('iki dugum bekleniyordu');
    a.x = 0;
    b.x = 0.01;
    a.y = 0;
    b.y = 0;
    warmUp(sim);
    expect(Math.hypot(a.x, a.y)).toBeLessThan(100);
    expect(Math.hypot(b.x, b.y)).toBeLessThan(100);
  });
});

describe('yerlesim olcutleri: 800 not + 300 hafiza kaydi', () => {
  it('ilk cizimde oturmus: buyuk graf da alpha 0 ile doner ve her acilista ayni sekil', () => {
    const sim = bigGraph();
    expect(sim.nodes).toHaveLength(1104);
    expect(isSettled(sim)).toBe(true);
    const { vault, records } = syntheticKnowledge(800, 300);
    expect(snapshot(buildGraph(vault, records))).toEqual(snapshot(sim));
  });

  it('on-isitma 1,5 sn altinda biter', () => {
    const { vault, records } = syntheticKnowledge(800, 300);
    // En iyi iki deneme: bu test yuk altinda CI'da gurultuye dayanikli olsun (olculen: ~0,4-0,6 sn).
    const elapsed = [0, 1].map(() => {
      const start = performance.now();
      buildGraph(vault, records);
      return performance.now() - start;
    });
    expect(Math.min(...elapsed)).toBeLessThan(1500);
  });

  it.each([
    ['1280x800 penceresi', LARGE],
    ['900x700 penceresi', SMALL],
  ])(
    'olcut 1 (%s): dugumlerin %%95i merkez dairesinde, en uzak dugum bile cercevede',
    (_, view) => {
      const result = measure(bigGraph(), view);
      expect(result.inCircle).toBeGreaterThanOrEqual(0.95);
      expect(result.allInFrame).toBe(true);
    },
  );

  it.each([
    ['1280x800 penceresi', LARGE],
    ['900x700 penceresi', SMALL],
  ])('olcut 2 (%s): kenarlar kisa, tuvali boydan boya kesen kenar yok', (_, view) => {
    const result = measure(bigGraph(), view);
    // Hedef: en uzun %1 kenar kisa kenarin %50sinden kisa. Eski motor: medyan ~0,7; %99 ~65 kat.
    expect(result.longestEdges).toBeLessThan(0.3);
    expect(result.medianEdge).toBeLessThan(0.1);
  });

  it('yerlesim gercekten toplu: sigdirma bir cerceve hilesi degil, dunya boyutu da kucuk', () => {
    const sim = bigGraph();
    const radii = sim.nodes.map((n) => Math.hypot(n.x, n.y));
    expect(percentile(radii, 0.95)).toBeLessThan(360);
    // Sigdirma sonrasi dugumler okunur boyutta kalir (cok uzaklasmaya zorlanmaz).
    expect(measure(sim, LARGE).scale).toBeGreaterThan(0.7);
    expect(measure(sim, SMALL).scale).toBeGreaterThan(0.55);
  });

  it('baglantisiz (yetim) dugumler de merkeze cekilir', () => {
    const sim = bigGraph();
    const degree = degreesOf(sim.nodes.length, sim.edges);
    const orphans = sim.nodes.filter((_, i) => degree[i] === 0);
    expect(orphans.length).toBeGreaterThan(100);
    const view = LARGE;
    const camera = fitCamera(sim, view, BOTH);
    const near = orphans.filter(
      (n) =>
        Math.hypot(n.x * camera.scale + camera.tx, n.y * camera.scale + camera.ty) <=
        0.45 * Math.min(view.width, view.height),
    );
    expect(near.length / orphans.length).toBeGreaterThanOrEqual(0.9);
  });

  it('dugumler ust uste binmez', () => {
    expect(overlappingPairs(bigGraph())).toBeLessThanOrEqual(2);
  });
});

describe('yeniden dagit', () => {
  const small = () => {
    const { vault, records } = syntheticKnowledge(120, 40);
    return buildGraph(vault, records);
  };

  it('tohum konumlara doner ve ilk acilistaki sekli AYNEN yeniden uretir (rastgele degil)', () => {
    const sim = small();
    const first = snapshot(sim);
    // Kullanici bir dugumu uzaklara surukledi; sonra "yeniden dagit".
    const dragged = sim.nodes[3];
    if (!dragged) throw new Error('dugum yok');
    dragged.x += 900;
    dragged.y -= 700;
    restart(sim);
    expect(isSettled(sim)).toBe(false);
    expect(snapshot(sim)).not.toEqual(first);
    simulate(sim, Infinity);
    expect(isSettled(sim)).toBe(true);
    expect(snapshot(sim)).toEqual(first);
  });

  it('adim adim (animasyon) ilerletmek tek seferde oturtmakla ayni sonucu verir', () => {
    const stepped = small();
    const whole = small();
    restart(stepped);
    while (!isSettled(stepped)) simulate(stepped, 2);
    restart(whole);
    simulate(whole, Infinity);
    expect(snapshot(stepped)).toEqual(snapshot(whole));
  });
});

describe('farkli graf sekillerinde de toplu kalir', () => {
  const notes = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `v/n${i}.md`,
      label: `n${i}.md`,
      vault: 'v',
      size: 1,
    }));
  const link = (from: number, to: number) => ({ from: `v/n${from}.md`, to: `v/n${to}.md` });

  const shapes: [string, VaultGraph][] = [
    ['hepsi yetim', { root: '/v', nodes: notes(600), edges: [] }],
    [
      'tek hub, 600 yaprak',
      {
        root: '/v',
        nodes: notes(601),
        edges: Array.from({ length: 600 }, (_, i) => link(0, i + 1)),
      },
    ],
    [
      '600 dugumluk zincir',
      {
        root: '/v',
        nodes: notes(600),
        edges: Array.from({ length: 599 }, (_, i) => link(i, i + 1)),
      },
    ],
    [
      'tek kenarla bagli iki yogun kume',
      {
        root: '/v',
        nodes: notes(400),
        edges: [
          ...Array.from({ length: 600 }, (_, i) => link(i % 200, (i * 37 + 11) % 200)),
          ...Array.from({ length: 600 }, (_, i) =>
            link(200 + (i % 200), 200 + ((i * 53 + 7) % 200)),
          ),
          link(5, 205),
        ],
      },
    ],
  ];

  it.each(shapes)('%s', (_, vault) => {
    const sim = buildGraph(vault, []);
    for (const n of sim.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    const result = measure(sim, LARGE);
    expect(result.inCircle).toBeGreaterThanOrEqual(0.95);
    expect(result.allInFrame).toBe(true);
    expect(result.longestEdges).toBeLessThan(0.5);
    expect(overlappingPairs(sim)).toBeLessThanOrEqual(Math.ceil(sim.nodes.length * 0.01));
  });
});
