import { describe, expect, it, vi } from 'vitest';

import type { GNode, Sim } from './graphModel.js';
import {
  drawGraph,
  fitCamera,
  hitTest,
  INITIAL_CAMERA,
  isVisible,
  neighborsOf,
  pan,
  toWorld,
  zoomAt,
  zoomCenter,
  type GraphScene,
  type ViewFlags,
} from './graphView.js';

const view = { width: 800, height: 600 };
const both: ViewFlags = { notes: true, memory: true };

function node(id: string, kind: GNode['kind'], x: number, y: number, r = 4): GNode {
  return { id, label: `${id}.md`, kind, color: '#ffffff', r, x, y, vx: 0, vy: 0 };
}

const simOf = (nodes: GNode[]): Sim => ({ nodes, edges: [] });

describe('kamera', () => {
  it('toWorld ekran noktasini kamera donusumunun tersiyle cozer', () => {
    const camera = { scale: 2, tx: 30, ty: -20 };
    const point = toWorld(camera, view, 500, 120);
    expect(point.x * camera.scale + view.width / 2 + camera.tx).toBeCloseTo(500);
    expect(point.y * camera.scale + view.height / 2 + camera.ty).toBeCloseTo(120);
  });

  it.each([1.12, 0.89, 1.2, 1 / 1.2])(
    'zoomAt (%f) imlec altindaki dunya noktasini sabit tutar',
    (factor) => {
      const camera = { scale: 1.5, tx: 40, ty: -25 };
      const before = toWorld(camera, view, 610, 140);
      const after = toWorld(zoomAt(camera, view, factor, 610, 140), view, 610, 140);
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
    },
  );

  it('olcek 0.25 ile 4 arasinda kalir', () => {
    expect(zoomAt(INITIAL_CAMERA, view, 100, 0, 0).scale).toBe(4);
    expect(zoomAt(INITIAL_CAMERA, view, 0.001, 0, 0).scale).toBe(0.25);
  });

  it('zoomCenter gorunumun ortasindaki dunya noktasini sabit tutar', () => {
    const camera = { scale: 1, tx: 60, ty: 10 };
    const center = toWorld(camera, view, view.width / 2, view.height / 2);
    const zoomed = zoomCenter(camera, view, 1.2);
    const after = toWorld(zoomed, view, view.width / 2, view.height / 2);
    expect(after.x).toBeCloseTo(center.x);
    expect(after.y).toBeCloseTo(center.y);
  });

  it('pan yalniz kaydirmayi degistirir', () => {
    expect(pan({ scale: 2, tx: 1, ty: 2 }, 10, -5)).toEqual({ scale: 2, tx: 11, ty: -3 });
  });
});

describe('gorunurluk dugmeleri (notlar / hafiza)', () => {
  it('not yalniz notes bayragiyla, mem ve hub yalniz memory bayragiyla gorunur', () => {
    const only = (flags: Partial<ViewFlags>) => ({ ...both, ...flags });
    expect(isVisible(node('n', 'note', 0, 0), only({ notes: false }))).toBe(false);
    expect(isVisible(node('m', 'mem', 0, 0), only({ notes: false }))).toBe(true);
    expect(isVisible(node('h', 'hub', 0, 0), only({ memory: false }))).toBe(false);
    expect(isVisible(node('n', 'note', 0, 0), only({ memory: false }))).toBe(true);
  });

  it('isabet testi gizli turdeki dugumu secmez', () => {
    const sim = simOf([node('n', 'note', 0, 0)]);
    const centre = { x: view.width / 2, y: view.height / 2 };
    expect(hitTest(sim, INITIAL_CAMERA, view, both, centre.x, centre.y)?.id).toBe('n');
    expect(
      hitTest(sim, INITIAL_CAMERA, view, { ...both, notes: false }, centre.x, centre.y),
    ).toBeNull();
  });
});

describe('hitTest', () => {
  const centre = { x: view.width / 2, y: view.height / 2 };

  it('isabet payi icindeki EN YAKIN dugumu doner', () => {
    const sim = simOf([node('uzak', 'note', 6, 0), node('yakin', 'note', 2, 0)]);
    expect(hitTest(sim, INITIAL_CAMERA, view, both, centre.x, centre.y)?.id).toBe('yakin');
  });

  it('pay disindaki tiklamada null doner', () => {
    const sim = simOf([node('a', 'note', 0, 0, 4)]);
    expect(hitTest(sim, INITIAL_CAMERA, view, both, centre.x + 30, centre.y)).toBeNull();
  });

  it('isabet payi EKRAN pikselidir: uzaklastirinca dunya olculusu buyur', () => {
    const sim = simOf([node('a', 'note', 20, 0, 4)]);
    const zoomedOut = { scale: 0.25, tx: 0, ty: 0 };
    const zoomedIn = { scale: 4, tx: 0, ty: 0 };
    // Ayni dunya uzakligi (20): 0.25'te ekranda 5 px, 4'te 80 px.
    expect(hitTest(sim, zoomedOut, view, both, centre.x, centre.y)?.id).toBe('a');
    expect(hitTest(sim, zoomedIn, view, both, centre.x, centre.y)).toBeNull();
  });
});

describe('drawGraph', () => {
  function fakeContext() {
    return {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn<(text: string, x: number, y: number) => void>(),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      font: '',
    };
  }

  const scene = (overrides: Partial<GraphScene>): GraphScene => ({
    sim: simOf([node('a', 'note', 0, 0), node('m', 'mem', 10, 10), node('h', 'hub', 20, 20, 7)]),
    camera: INITIAL_CAMERA,
    view,
    flags: both,
    selectedId: null,
    pixelRatio: 1,
    ...overrides,
  });

  const draw = (overrides: Partial<GraphScene>) => {
    const ctx = fakeContext();
    drawGraph(ctx as unknown as CanvasRenderingContext2D, scene(overrides));
    return ctx;
  };

  it('gorunur her dugumu bir daire olarak cizer', () => {
    expect(draw({}).arc).toHaveBeenCalledTimes(3);
  });

  it('kapatilan turdeki dugumleri cizmez (notlar kapaliyken 2 daire)', () => {
    expect(draw({ flags: { notes: false, memory: true } }).arc).toHaveBeenCalledTimes(2);
    expect(draw({ flags: { notes: true, memory: false } }).arc).toHaveBeenCalledTimes(1);
  });

  it('hub etiketi her zaman, not etiketi yalniz yakinlasinca yazilir', () => {
    expect(draw({}).fillText).toHaveBeenCalledTimes(1);
    const zoomed = draw({ camera: { scale: 2, tx: 0, ty: 0 } });
    expect(zoomed.fillText.mock.calls.map(([text]) => text)).toEqual(['a', 'h.md']);
  });

  it('secili dugume halka ve etiket ekler', () => {
    const ctx = draw({ selectedId: 'a' });
    expect(ctx.arc).toHaveBeenCalledTimes(4);
    expect(ctx.fillText.mock.calls.map(([text]) => text)).toContain('a');
  });

  it('gizli turdeki secili dugume halka cizmez', () => {
    const ctx = draw({ selectedId: 'a', flags: { notes: false, memory: true } });
    expect(ctx.arc).toHaveBeenCalledTimes(2);
  });

  it('veri yokken yalniz temizler', () => {
    const ctx = draw({ sim: null });
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.arc).not.toHaveBeenCalled();
  });
});

describe('fitCamera (ilk acilista tum grafi sigdirir)', () => {
  const short = Math.min(view.width, view.height);
  const screenOf = (camera: ReturnType<typeof fitCamera>, n: GNode) => ({
    x: view.width / 2 + camera.tx + n.x * camera.scale,
    y: view.height / 2 + camera.ty + n.y * camera.scale,
  });
  /** Yaricapi `radius` olan halka uzerinde esit aralikli `count` dugum. */
  const ring = (count: number, radius: number, cx = 0, cy = 0): GNode[] =>
    Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      return node(`r${i}`, 'note', cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 2);
    });

  it('gorunur dugum yoksa baslangic kamerasini doner', () => {
    expect(fitCamera(simOf([]), view, both)).toEqual(INITIAL_CAMERA);
    expect(fitCamera(simOf(ring(5, 100)), view, { notes: false, memory: true })).toEqual(
      INITIAL_CAMERA,
    );
  });

  it('cizilecek alan yoksa (gizli bolum, 0 olcu) baslangic kamerasini doner', () => {
    expect(fitCamera(simOf(ring(5, 100)), { width: 0, height: 0 }, both)).toEqual(INITIAL_CAMERA);
  });

  it('merkezi gorunumun ortasina getirir (sentroid sifir olmasa da)', () => {
    const nodes = ring(40, 200, 1500, -900);
    const camera = fitCamera(simOf(nodes), view, both);
    const first = nodes[0];
    const opposite = nodes[20];
    if (!first || !opposite) throw new Error('dugum yok');
    const a = screenOf(camera, first);
    const b = screenOf(camera, opposite);
    expect((a.x + b.x) / 2).toBeCloseTo(view.width / 2, 0);
    expect((a.y + b.y) / 2).toBeCloseTo(view.height / 2, 0);
  });

  it('dugumlerin %95i kisa kenarin %38i yaricapli daireye oturur', () => {
    const camera = fitCamera(simOf(ring(200, 300)), view, both);
    const farthest = screenOf(camera, node('x', 'note', 300, 0));
    expect(Math.hypot(farthest.x - view.width / 2, farthest.y - view.height / 2)).toBeCloseTo(
      0.38 * short,
      0,
    );
  });

  it('seyrek uc dugum kalabaligi ezmez ama cerceve disinda da kalmaz', () => {
    const crowd = ring(300, 100);
    const outlier = node('uzak', 'note', 700, 0, 2);
    const camera = fitCamera(simOf([...crowd, outlier]), view, both);
    const edge = screenOf(camera, outlier);
    expect(edge.x).toBeLessThanOrEqual(view.width);
    expect(edge.x).toBeGreaterThan(0);
    // Uc dugum cerceveye girmek icin olcegi kisar; ama olcek tabana (0.25) inmez.
    const alone = fitCamera(simOf(crowd), view, both);
    expect(camera.scale).toBeLessThan(alone.scale);
    expect(camera.scale).toBeGreaterThan(0.25);
  });

  it('az dugumlu grafta dev dugum uretmez (olcek tavani)', () => {
    expect(
      fitCamera(simOf([node('tek', 'note', 10, 10, 3)]), view, both).scale,
    ).toBeLessThanOrEqual(2);
    expect(fitCamera(simOf(ring(3, 5)), view, both).scale).toBeLessThanOrEqual(2);
  });

  it('gizlenen turdeki dugumler sigdirmaya katilmaz', () => {
    const notes = ring(50, 100);
    const farMemory = ring(50, 3000).map((n) => ({ ...n, id: `m${n.id}`, kind: 'mem' as const }));
    const hidden = fitCamera(simOf([...notes, ...farMemory]), view, { notes: true, memory: false });
    expect(hidden).toEqual(fitCamera(simOf(notes), view, both));
  });
});

describe('neighborsOf', () => {
  const a = node('a', 'note', 0, 0);
  const b = node('b', 'note', 10, 0);
  const c = node('c', 'mem', 20, 0);
  const d = node('d', 'note', 30, 0);
  const sim: Sim = {
    nodes: [a, b, c, d],
    edges: [
      { a: 0, b: 1 },
      { a: 2, b: 0 },
      { a: 1, b: 3 },
    ],
  };

  it('her iki yondeki komsulari doner, kendisini degil', () => {
    expect([...neighborsOf(sim, a, both)].map((n) => n.id).sort()).toEqual(['b', 'c']);
  });

  it('gizli turdeki komsu sayilmaz', () => {
    expect([...neighborsOf(sim, a, { notes: true, memory: false })].map((n) => n.id)).toEqual([
      'b',
    ]);
  });

  it('baglantisiz dugumun komsusu yoktur', () => {
    expect(neighborsOf({ nodes: [a, b], edges: [] }, a, both).size).toBe(0);
  });
});

describe('drawGraph: ustune gelince komsular parlar, digerleri soner', () => {
  /** arc cagrisinda gecerli globalAlpha'yi ve her stroke'ta strokeStyle'i kaydeden sahte baglam. */
  function recordingContext(order: GNode[]) {
    let alpha = 1;
    const arcAlphas = new Map<string, number>();
    const strokeStyles: string[] = [];
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn<(text: string, x: number, y: number) => void>(),
      stroke: vi.fn(),
      arc: vi.fn(),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      font: '',
    };
    ctx.stroke.mockImplementation(() => strokeStyles.push(ctx.strokeStyle));
    ctx.arc.mockImplementation((x: number, y: number) => {
      const owner = order.find((n) => n.x === x && n.y === y);
      if (owner) arcAlphas.set(owner.id, alpha);
    });
    Object.defineProperty(ctx, 'globalAlpha', {
      get: () => alpha,
      set: (value: number) => {
        alpha = value;
      },
    });
    return { ctx, arcAlphas, strokeStyles };
  }

  const hovered = node('odak', 'note', 0, 0);
  const near = node('komsu', 'note', 40, 0);
  const far = node('uzak', 'note', 0, 60);
  const memory: GNode = {
    ...node('kayit', 'mem', -40, 0),
    record: {
      id: 'kayit',
      content: 'Bu hafiza kaydinin metni kirk sekiz karakterden cok daha uzun yazilmistir.',
      sourceType: 'github',
      sourceId: 'github:1',
      sensitivity: 'normal',
      createdAt: '2026-10-03T10:00:00.000Z',
    },
  };
  const sim: Sim = {
    nodes: [hovered, near, far, memory],
    edges: [
      { a: 0, b: 1 },
      { a: 2, b: 3 },
    ],
  };

  const run = (overrides: Partial<GraphScene>) => {
    const recorded = recordingContext(sim.nodes);
    drawGraph(recorded.ctx as unknown as CanvasRenderingContext2D, {
      sim,
      camera: INITIAL_CAMERA,
      view,
      flags: both,
      selectedId: null,
      pixelRatio: 1,
      ...overrides,
    });
    return recorded;
  };

  it('imlec yokken her dugum tam opaklikta, kenarlar tek gecis', () => {
    const { arcAlphas, strokeStyles } = run({});
    expect([...arcAlphas.values()].every((alpha) => alpha === 1)).toBe(true);
    expect(strokeStyles).toHaveLength(1);
  });

  it('odak ve komsusu tam opak, baglantisiz diger dugumler soluk cizilir', () => {
    const { arcAlphas } = run({ hoveredId: 'odak' });
    expect(arcAlphas.get('odak')).toBe(1);
    expect(arcAlphas.get('komsu')).toBe(1);
    expect(arcAlphas.get('uzak')).toBeLessThan(0.5);
    expect(arcAlphas.get('kayit')).toBeLessThan(0.5);
  });

  it('odagin kenarlari ayri, daha parlak bir gecisle cizilir; digerleri soluklasir', () => {
    const idle = run({});
    const focused = run({ hoveredId: 'odak' });
    // Gecisler: soluk kenarlar, odagin parlak kenarlari, odak halkasi.
    expect(focused.strokeStyles).toHaveLength(3);
    const [dim, lit, ring] = focused.strokeStyles;
    expect(dim).not.toBe(idle.strokeStyles[0]);
    expect(lit).not.toBe(dim);
    expect(ring).not.toBe(lit);
  });

  it('odak dugume halka ekler (secili degilse)', () => {
    expect(run({ hoveredId: 'odak' }).ctx.arc).toHaveBeenCalledTimes(sim.nodes.length + 1);
    expect(run({}).ctx.arc).toHaveBeenCalledTimes(sim.nodes.length);
  });

  it('odak dugumun etiketi yakinlasmadan da yazilir; hafiza kaydinda metin ozeti gosterilir', () => {
    const noteLabels = run({ hoveredId: 'odak' }).ctx.fillText.mock.calls;
    expect(noteLabels.map(([text]) => text)).toEqual(['odak']);
    const [memoryLabel] = run({ hoveredId: 'kayit' }).ctx.fillText.mock.calls[0] ?? [];
    expect(memoryLabel?.startsWith('Bu hafiza kaydinin')).toBe(true);
    expect(memoryLabel?.length).toBeLessThan(60);
  });

  it('gizli turdeki dugum odak olamaz: grafik normal cizilir', () => {
    const { arcAlphas, strokeStyles } = run({
      hoveredId: 'kayit',
      flags: { notes: true, memory: false },
    });
    expect([...arcAlphas.values()].every((alpha) => alpha === 1)).toBe(true);
    expect(strokeStyles).toHaveLength(1);
  });

  it('olmayan kimlik odak yaratmaz', () => {
    expect(run({ hoveredId: 'yok' }).strokeStyles).toHaveLength(1);
  });
});

describe('drawGraph: etiketler kalabalik yapmaz', () => {
  function labelsOf(nodes: GNode[], overrides: Partial<GraphScene>): string[] {
    const fillText = vi.fn<(text: string, x: number, y: number) => void>();
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillText,
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      font: '',
    };
    drawGraph(ctx as unknown as CanvasRenderingContext2D, {
      sim: simOf(nodes),
      camera: { scale: 2, tx: 0, ty: 0 },
      view,
      flags: both,
      selectedId: null,
      pixelRatio: 1,
      ...overrides,
    });
    return fillText.mock.calls.map(([text]) => text);
  }

  it('ust uste binecek etiketlerden yalniz en buyuk dugumunki yazilir', () => {
    const big = node('buyuk', 'note', 0, 0, 8);
    const small = node('kucuk', 'note', 3, 2, 3);
    const apart = node('uzak', 'note', 100, 60, 3);
    expect(labelsOf([small, big, apart], {})).toEqual(['buyuk', 'uzak']);
  });

  it('ekran disindaki dugumun etiketi yazilmaz', () => {
    const inside = node('ici', 'note', 0, 0);
    const outside = node('disi', 'note', 5000, 0);
    expect(labelsOf([inside, outside], {})).toEqual(['ici']);
  });

  it('sag kenara tasan etiket dugumun soluna alinir (kesilmez)', () => {
    const placed: { text: string; x: number; align: string }[] = [];
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      font: '',
      textAlign: 'start',
    };
    ctx.fillText.mockImplementation((text: string, x: number) =>
      placed.push({ text, x, align: ctx.textAlign }),
    );
    // Sahne 800 genis; dugum merkezden 380 px sagda: "conversation" saga sigmaz.
    const edge = node('conversation', 'hub', 190, 0, 7);
    const inner = node('ortada', 'hub', 0, 0, 7);
    drawGraph(ctx as unknown as CanvasRenderingContext2D, {
      sim: simOf([edge, inner]),
      camera: { scale: 2, tx: 0, ty: 0 },
      view,
      flags: both,
      selectedId: null,
      pixelRatio: 1,
    });
    const byText = new Map(placed.map((label) => [label.text, label]));
    expect(byText.get('conversation.md')?.align).toBe('right');
    expect(byText.get('conversation.md')?.x).toBeLessThan(edge.x);
    expect(byText.get('ortada.md')?.align).toBe('left');
    expect(byText.get('ortada.md')?.x).toBeGreaterThan(inner.x);
    expect(ctx.textAlign).toBe('left');
  });

  it('odak ve secili dugumun etiketi baska etiketle cakissa da yazilir', () => {
    const hub = node('h', 'hub', 0, 0, 7);
    const other = node('d', 'note', 4, 1, 4);
    const labels = labelsOf([hub, other], { selectedId: 'd' });
    expect(labels).toContain('d');
  });
});
