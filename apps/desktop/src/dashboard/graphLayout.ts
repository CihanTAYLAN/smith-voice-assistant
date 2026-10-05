import type { GEdge, GNode, LayoutSim, Link, Sim } from './graphModel.js';

/**
 * YERLESIM MOTORU: Obsidian benzeri kuvvet yonlendirmeli yerlesim (saf, DOM'suz).
 *
 *  - Itme: Barnes-Hut dortlu agac (O(n log n)), 1/d yasasi. En kucuk mesafe
 *    sinirli: ust uste binen iki dugum sonsuz itilmez. Eski motor 1/d^2 idi ve
 *    sinir yoktu; yakin cifte binlerce birim hiz verip dugumleri sahne disina
 *    firlatiyordu ("uzak dugumlere uzanan uzun cizgiler" buradan geliyordu).
 *  - Yay: kenar basina; guc ve yanlilik dereceyle orantili (hub az, yaprak cok
 *    hareket eder). Dinlenme boyu dugum yaricaplarini icerir.
 *  - Merkez cekimi: HER dugume (baglantisizlar dahil), mesafeyle dogrusal.
 *  - Carpisma: dugumler ust uste binmez (sogumanin son evresinde).
 *  - Sogutma: alpha 1 -> 0; bitince yerlesim DURUR, animasyon kendiliginden biter.
 *  - Deterministik: Math.random yok; ayni veri her acilista ayni sekli verir.
 */

export const FORCES = {
  /** Itme gucu (her dugum ayni yukte). */
  charge: 30,
  /** Barnes-Hut yakinlik olcutu: hucre boyu / mesafe bundan kucukse tek kutle sayilir. */
  theta: 1.2,
  /** Bu mesafeden uzak hucreler itmeye katilmaz (yakinsama hizi + yerel yapi). */
  chargeRange: 420,
  /** Itme bu mesafenin altinda yumusakca sonumlenir (sonsuz kuvveti onler). */
  minDistance: 6,
  /** Yayin dinlenme boyu = bu deger + iki ucun yaricaplari toplami. */
  linkDistance: 12,
  /** Yay gucunun tabani: yuksek dereceli ciftler de gevsemez, kenarlar kisa kalir. */
  linkFloor: 0.5,
  /** Merkeze dogrusal cekim (tum dugumler). */
  gravity: 0.3,
  /** Yetim dugumlerin cekim sapmasi (0..1): tek halka (kolye) yerine genis bant olusur. */
  orphanSpread: 0.35,
  /** Carpisma: ust uste binen dugumleri ayirma gucu (0 = kapali) ve dugumler arasi bosluk. */
  collide: 0.8,
  collidePad: 1.5,
  /** Carpisma yalniz alpha bu degerin altindayken calisir (erken adimlar pahali ve gereksiz). */
  collideBelowAlpha: 0.3,
  /** Her adimda hizin korunan orani (d3: 0.6). */
  damping: 0.6,
  /** Alpha 1'den alphaMin'e bu kadar adimda soguyur. */
  coolTicks: 220,
  alphaMin: 0.001,
  /** Suruklemede komsulari canli tutan dusuk isi hedefi (d3 varsayimina yakin). */
  dragAlphaTarget: 0.3,
  /** Tohum yerlesiminin aralik olcegi (dunya pikseli). */
  seedSpacing: 13,
};

const GOLDEN_ANGLE = 2.399963229728653;

/** Tohumdan [0, 1) araliginda deterministik sayi (Math.random yerine). */
const hash01 = (seed: number): number =>
  (Math.imul(Math.imul(seed + 1, 2654435761) ^ (seed >>> 3), 2246822519) >>> 0) / 4294967296;

/** Ayni konumdaki iki dugumu ayirmak icin deterministik, sifir olmayan sapma. */
const jiggle = (seed: number): number => (hash01(seed) - 0.5) * 1e-3;

/** Her dugumun baglanti sayisi (kendine donen kenar sayilmaz). */
export function degreesOf(count: number, edges: readonly GEdge[]): number[] {
  const degree = new Array<number>(count).fill(0);
  for (const edge of edges) {
    if (edge.a === edge.b) continue;
    degree[edge.a] = (degree[edge.a] ?? 0) + 1;
    degree[edge.b] = (degree[edge.b] ?? 0) + 1;
  }
  return degree;
}

/** Komsuluk listesi (kenar sirasiyla; deterministik). */
function adjacencyOf(count: number, edges: readonly GEdge[]): number[][] {
  const adjacency: number[][] = Array.from({ length: count }, () => []);
  for (const edge of edges) {
    if (edge.a === edge.b) continue;
    adjacency[edge.a]?.push(edge.b);
    adjacency[edge.b]?.push(edge.a);
  }
  return adjacency;
}

/**
 * Tohum yerlesimi: bilesenler buyukten kucuge, her bilesen en yuksek dereceli
 * dugumden BFS sirasiyla altin aci spirali uzerine dizilir. Baglantili dugumler
 * spiralde birbirine yakin halkalara duser (hub merkezde), yetimler en disa.
 */
export function seedPositions(nodes: readonly GNode[], edges: readonly GEdge[]): void {
  const adjacency = adjacencyOf(nodes.length, edges);
  const seen = new Array<boolean>(nodes.length).fill(false);
  const components: number[][] = [];
  const byDegree = nodes
    .map((_, index) => index)
    .sort((a, b) => (adjacency[b]?.length ?? 0) - (adjacency[a]?.length ?? 0) || a - b);
  for (const start of byDegree) {
    if (seen[start]) continue;
    seen[start] = true;
    const order = [start];
    for (let head = 0; head < order.length; head++) {
      for (const next of adjacency[order[head] ?? 0] ?? []) {
        if (seen[next]) continue;
        seen[next] = true;
        order.push(next);
      }
    }
    components.push(order);
  }
  components.sort((a, b) => b.length - a.length);

  let slot = 0;
  for (const component of components) {
    for (const index of component) {
      const node = nodes[index];
      if (!node) continue;
      // Hafif sapma: duz spiralin kollari simulasyondan sonra da zincir olarak kalirdi.
      const radius = FORCES.seedSpacing * Math.sqrt(slot + 0.5) * (1 + 0.5 * hash01(slot));
      const angle = slot * GOLDEN_ANGLE + 2 * Math.PI * hash01(slot + 104729);
      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
      node.vx = 0;
      node.vy = 0;
      slot++;
    }
  }
}

function linksOf(sim: Sim, degree: readonly number[]): Link[] {
  const links: Link[] = [];
  for (const edge of sim.edges) {
    const a = sim.nodes[edge.a];
    const b = sim.nodes[edge.b];
    if (!a || !b || a === b) continue;
    const da = degree[edge.a] ?? 1;
    const db = degree[edge.b] ?? 1;
    links.push({
      a,
      b,
      rest: FORCES.linkDistance + a.r + b.r,
      strength: Math.max(FORCES.linkFloor, 1 / Math.min(da, db)),
      bias: da / (da + db),
    });
  }
  return links;
}

/** Cizilebilir grafa yerlesim durumu ekler: tohum konumlar + sogumus (alpha 0) motor. */
export function createLayout(sim: Sim, degree: readonly number[]): LayoutSim {
  seedPositions(sim.nodes, sim.edges);
  const gravity = degree.map((connections, index) => {
    const spread = connections === 0 ? FORCES.orphanSpread * (2 * hash01(index + 31) - 1) : 0;
    return FORCES.gravity * (1 + spread);
  });
  return {
    nodes: sim.nodes,
    edges: sim.edges,
    links: linksOf(sim, degree),
    gravity,
    alpha: 0,
    alphaTarget: 0,
  };
}

/** Motoru isitir: sonraki `simulate` adimlari yerlesimi yeniden oturtur. */
export function reheat(sim: LayoutSim): void {
  sim.alpha = 1;
}

/** Dugumu imlece sabitler ve komsularin yaylarla takip etmesi icin motoru canli tutar. */
export function pinNode(sim: LayoutSim, node: GNode, x: number, y: number): void {
  node.fx = x;
  node.fy = y;
  node.x = x;
  node.y = y;
  node.vx = 0;
  node.vy = 0;
  sim.alphaTarget = FORCES.dragAlphaTarget;
  sim.alpha = Math.max(sim.alpha, sim.alphaTarget);
}

/** Dugumu serbest birakir; motor yeniden alpha 0'a sogur. */
export function releaseNode(sim: LayoutSim, node: GNode): void {
  node.fx = undefined;
  node.fy = undefined;
  sim.alphaTarget = 0;
}

/** "Yeniden dagit": tohum konumlara don ve bastan sogut (rastgelelik yok, ayni sekil). */
export function restart(sim: LayoutSim): void {
  for (const node of sim.nodes) {
    node.fx = undefined;
    node.fy = undefined;
  }
  sim.alphaTarget = 0;
  seedPositions(sim.nodes, sim.edges);
  reheat(sim);
}

/** Yerlesim oturdu mu (alpha tabana indi)? Animasyon dongusu bunu bekler. */
export const isSettled = (sim: LayoutSim): boolean => sim.alpha <= 0;

// --- Barnes-Hut dortlu agac -------------------------------------------------

const EMPTY = -1;
const INTERNAL = -2;
const NO_CELL = -1;
/** Bundan kucuk hucre bolunmez: ayni noktadaki dugumler tek yaprakta toplanir. */
const MIN_CELL = 1e-3;
const STACK_SIZE = 1024;

/**
 * Dortlu agac, yapi-dizisi (typed array) olarak: hucre basina nesne yok, her
 * adimda ayni tamponlar yeniden kullanilir. Yaprak = en cok bir dugum;
 * `body`: dugum indeksi, EMPTY (bos yaprak) ya da INTERNAL (alt hucreli).
 * Hucre alani: sol ust kose + kenar; kutle (= dugum sayisi) ve kutle merkezi;
 * icindeki en buyuk dugum yaricapi (carpisma sorgusunu kirpmak icin).
 */
class QuadTree {
  private capacity = 0;
  private count = 0;
  private originX = new Float64Array(0);
  private originY = new Float64Array(0);
  private size = new Float64Array(0);
  private size2 = new Float64Array(0);
  private mass = new Float64Array(0);
  private reach = new Float64Array(0);
  private sumX = new Float64Array(0);
  private sumY = new Float64Array(0);
  private centerX = new Float64Array(0);
  private centerY = new Float64Array(0);
  private body = new Int32Array(0);
  private kids = new Int32Array(0);
  private readonly stack = new Int32Array(STACK_SIZE);

  rebuild(nodes: readonly GNode[]): void {
    this.count = 0;
    if (nodes.length === 0) return;
    this.reserve(nodes.length * 3 + 16);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    }
    this.open(minX, minY, Math.max(maxX - minX, maxY - minY) + 1);
    nodes.forEach((node, index) => this.insert(nodes, index, node));
    for (let cell = 0; cell < this.count; cell++) {
      const mass = this.mass[cell] ?? 1;
      this.centerX[cell] = (this.sumX[cell] ?? 0) / mass;
      this.centerY[cell] = (this.sumY[cell] ?? 0) / mass;
    }
  }

  /** `node`un uzerine tum agacin itmesini hiz olarak ekler (kendisi haric). */
  repel(node: GNode, index: number, strength: number): void {
    const theta2 = FORCES.theta * FORCES.theta;
    const range2 = FORCES.chargeRange * FORCES.chargeRange;
    const min2 = FORCES.minDistance * FORCES.minDistance;
    const { stack, centerX, centerY, mass, size2, body, kids } = this;
    let pushX = 0;
    let pushY = 0;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const cell = stack[--top] ?? 0;
      let dx = (centerX[cell] ?? 0) - node.x;
      let dy = (centerY[cell] ?? 0) - node.y;
      let d2 = dx * dx + dy * dy;
      const resident = body[cell] ?? EMPTY;
      if (resident === INTERNAL) {
        if ((size2[cell] ?? 0) >= theta2 * d2) {
          for (let q = 0; q < 4; q++) {
            const kid = kids[cell * 4 + q] ?? NO_CELL;
            if (kid !== NO_CELL) stack[top++] = kid;
          }
          continue;
        }
      } else if (resident === index) {
        continue;
      } else if (d2 === 0) {
        dx = jiggle(index);
        dy = jiggle(index + 7919);
        d2 = dx * dx + dy * dy;
      }
      if (d2 >= range2) continue;
      const w = (strength * (mass[cell] ?? 0)) / Math.max(d2, min2);
      pushX -= dx * w;
      pushY -= dy * w;
    }
    node.vx += pushX;
    node.vy += pushY;
  }

  /** Ust uste binen daha yuksek indeksli komsulari ayirir (hiz olarak; cift bir kez islenir). */
  separate(nodes: readonly GNode[], node: GNode, index: number): void {
    const { stack, originX, originY, size, reach, body, kids } = this;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const cell = stack[--top] ?? 0;
      const ox = originX[cell] ?? 0;
      const oy = originY[cell] ?? 0;
      const span = size[cell] ?? 0;
      const around = node.r + (reach[cell] ?? 0) + FORCES.collidePad;
      if (node.x + around < ox || node.x - around > ox + span) continue;
      if (node.y + around < oy || node.y - around > oy + span) continue;
      const resident = body[cell] ?? EMPTY;
      if (resident === INTERNAL) {
        for (let q = 0; q < 4; q++) {
          const kid = kids[cell * 4 + q] ?? NO_CELL;
          if (kid !== NO_CELL) stack[top++] = kid;
        }
        continue;
      }
      const other = resident > index ? nodes[resident] : undefined;
      if (!other) continue;
      let dx = node.x - other.x;
      let dy = node.y - other.y;
      const touching = node.r + other.r + FORCES.collidePad;
      let d2 = dx * dx + dy * dy;
      if (d2 >= touching * touching) continue;
      if (d2 === 0) {
        dx = jiggle(index);
        dy = jiggle(index + 7919);
        d2 = dx * dx + dy * dy;
      }
      // Kucuk dugum cok, buyuk dugum az oynar (kutle ~ yaricap^2).
      const push = ((touching - Math.sqrt(d2)) / Math.sqrt(d2)) * FORCES.collide;
      const mine = node.r * node.r;
      const theirs = other.r * other.r;
      node.vx += dx * push * (theirs / (mine + theirs));
      node.vy += dy * push * (theirs / (mine + theirs));
      other.vx -= dx * push * (mine / (mine + theirs));
      other.vy -= dy * push * (mine / (mine + theirs));
    }
  }

  private reserve(capacity: number): void {
    if (capacity <= this.capacity) return;
    const widen = (old: Float64Array) => {
      const next = new Float64Array(capacity);
      next.set(old);
      return next;
    };
    this.originX = widen(this.originX);
    this.originY = widen(this.originY);
    this.size = widen(this.size);
    this.size2 = widen(this.size2);
    this.mass = widen(this.mass);
    this.reach = widen(this.reach);
    this.sumX = widen(this.sumX);
    this.sumY = widen(this.sumY);
    this.centerX = widen(this.centerX);
    this.centerY = widen(this.centerY);
    const body = new Int32Array(capacity);
    body.set(this.body);
    this.body = body;
    const kids = new Int32Array(capacity * 4);
    kids.set(this.kids);
    this.kids = kids;
    this.capacity = capacity;
  }

  /** Yeni bos yaprak acar; indeksini doner. */
  private open(x: number, y: number, size: number): number {
    if (this.count === this.capacity) this.reserve(this.capacity * 2);
    const cell = this.count++;
    this.originX[cell] = x;
    this.originY[cell] = y;
    this.size[cell] = size;
    this.size2[cell] = size * size;
    this.mass[cell] = 0;
    this.reach[cell] = 0;
    this.sumX[cell] = 0;
    this.sumY[cell] = 0;
    this.body[cell] = EMPTY;
    this.kids.fill(NO_CELL, cell * 4, cell * 4 + 4);
    return cell;
  }

  private quadrant(cell: number, x: number, y: number): number {
    const half = (this.size[cell] ?? 0) / 2;
    const right = x >= (this.originX[cell] ?? 0) + half ? 1 : 0;
    const lower = y >= (this.originY[cell] ?? 0) + half ? 2 : 0;
    return right + lower;
  }

  private childAt(cell: number, quadrant: number): number {
    const existing = this.kids[cell * 4 + quadrant] ?? NO_CELL;
    if (existing !== NO_CELL) return existing;
    const half = (this.size[cell] ?? 0) / 2;
    const made = this.open(
      (this.originX[cell] ?? 0) + (quadrant & 1) * half,
      (this.originY[cell] ?? 0) + (quadrant >> 1) * half,
      half,
    );
    this.kids[cell * 4 + quadrant] = made;
    return made;
  }

  private insert(nodes: readonly GNode[], index: number, node: GNode): void {
    let cell = 0;
    for (;;) {
      this.mass[cell] = (this.mass[cell] ?? 0) + 1;
      this.reach[cell] = Math.max(this.reach[cell] ?? 0, node.r);
      this.sumX[cell] = (this.sumX[cell] ?? 0) + node.x;
      this.sumY[cell] = (this.sumY[cell] ?? 0) + node.y;
      const resident = this.body[cell] ?? EMPTY;
      if (resident === EMPTY) {
        this.body[cell] = index;
        return;
      }
      if (resident !== INTERNAL) {
        if ((this.size[cell] ?? 0) < MIN_CELL) return;
        // Yaprak doluydu: sakini bir alt hucreye indir (kutlesi bu hucrede sayildi).
        const other = nodes[resident];
        if (!other) return;
        this.body[cell] = INTERNAL;
        const home = this.childAt(cell, this.quadrant(cell, other.x, other.y));
        this.mass[home] = 1;
        this.reach[home] = other.r;
        this.sumX[home] = other.x;
        this.sumY[home] = other.y;
        this.body[home] = resident;
      }
      cell = this.childAt(cell, this.quadrant(cell, node.x, node.y));
    }
  }
}

function pull(links: readonly Link[], alpha: number): void {
  links.forEach((link, index) => {
    const { a, b } = link;
    let dx = b.x + b.vx - a.x - a.vx;
    let dy = b.y + b.vy - a.y - a.vy;
    if (dx === 0 && dy === 0) {
      dx = jiggle(index);
      dy = jiggle(index + 7919);
    }
    const length = Math.sqrt(dx * dx + dy * dy);
    const k = ((length - link.rest) / length) * alpha * link.strength;
    dx *= k;
    dy *= k;
    b.vx -= dx * link.bias;
    b.vy -= dy * link.bias;
    a.vx += dx * (1 - link.bias);
    a.vy += dy * (1 - link.bias);
  });
}

// Tamponlar adimlar arasi paylasilir (tek is parcacigi); sonuc onceki cagrilara bagli degildir.
const tree = new QuadTree();

/**
 * `ticks` adim ilerletir; alpha tabana inince durur (ek adimlar bos gecer, bu
 * yuzden `Infinity` da guvenlidir: sogutma sonludur). Konumlari yerinde gunceller.
 */
export function simulate(sim: LayoutSim, ticks: number): void {
  const { nodes, links, gravity } = sim;
  const alphaDecay = 1 - Math.pow(FORCES.alphaMin, 1 / FORCES.coolTicks);
  for (let tick = 0; tick < ticks && !isSettled(sim); tick++) {
    sim.alpha += (sim.alphaTarget - sim.alpha) * alphaDecay;
    if (sim.alphaTarget === 0 && sim.alpha < FORCES.alphaMin) sim.alpha = 0;

    nodes.forEach((node) => {
      if (node.fx === undefined || node.fy === undefined) return;
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
    });

    tree.rebuild(nodes);
    const strength = FORCES.charge * sim.alpha;
    nodes.forEach((node, index) => tree.repel(node, index, strength));
    pull(links, sim.alpha);
    if (FORCES.collide > 0 && sim.alpha < FORCES.collideBelowAlpha) {
      nodes.forEach((node, index) => tree.separate(nodes, node, index));
    }
    nodes.forEach((node, index) => {
      if (node.fx !== undefined && node.fy !== undefined) {
        node.x = node.fx;
        node.y = node.fy;
        node.vx = 0;
        node.vy = 0;
        return;
      }
      const toCenter = (gravity[index] ?? 0) * sim.alpha;
      node.vx = (node.vx - node.x * toCenter) * FORCES.damping;
      node.vy = (node.vy - node.y * toCenter) * FORCES.damping;
      node.x += node.vx;
      node.y += node.vy;
    });
  }
}

/** On-isitma: motoru isitir ve soguyana kadar (`coolTicks` adim) senkron surer. */
export function warmUp(sim: LayoutSim): void {
  reheat(sim);
  simulate(sim, Infinity);
}
