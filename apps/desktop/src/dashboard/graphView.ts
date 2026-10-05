import type { GNode, Sim } from './graphModel.js';

/**
 * Bilgi grafigi gorunumu: kamera matematigi, isabet testi ve canvas cizimi.
 * Hepsi saf fonksiyonlardir (DOM'u bilmez; canvas baglami parametre gelir),
 * bu yuzden pan/zoom/secim davranisi Node'da test edilir.
 */

export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Hangi dugum turleri gorunur: notlar ayri, hafiza kayitlari + kaynak grubu (hub) ayri. */
export interface ViewFlags {
  notes: boolean;
  memory: boolean;
}

export const INITIAL_CAMERA: Camera = { scale: 1, tx: 0, ty: 0 };

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/** Isabet payi: dugum yaricapina ekran pikseli cinsinden eklenir. */
const HIT_SLOP_PX = 6;
/** Notlarin etiketi yalniz bu yakinlastirmadan sonra yazilir. */
const NOTE_LABEL_SCALE = 1.6;
/** Sigdirma: dugumlerin %95'i, kisa kenarin bu orani yaricapli merkez dairesinde kalir. */
const FIT_CORE_RATIO = 0.38;
/** Sigdirma: en uzak dugum ile cerceve arasinda birakilan bos pay (ekran pikseli). */
const FIT_FRAME_PAD_PX = 16;
/** Az dugumlu grafta sigdirma dev dugum uretmesin diye ust olcek. */
const FIT_MAX_SCALE = 2;

export const isVisible = (node: GNode, flags: ViewFlags): boolean =>
  node.kind === 'note' ? flags.notes : flags.memory;

const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Canvas ici ekran noktasini (piksel) dunya koordinatina cevirir. */
export function toWorld(camera: Camera, view: Viewport, px: number, py: number) {
  return {
    x: (px - view.width / 2 - camera.tx) / camera.scale,
    y: (py - view.height / 2 - camera.ty) / camera.scale,
  };
}

/** `(px, py)` altindaki dunya noktasi yerinde kalacak sekilde olcekler. */
export function zoomAt(
  camera: Camera,
  view: Viewport,
  factor: number,
  px: number,
  py: number,
): Camera {
  const scale = clampScale(camera.scale * factor);
  const anchor = toWorld(camera, view, px, py);
  return {
    scale,
    tx: px - view.width / 2 - anchor.x * scale,
    ty: py - view.height / 2 - anchor.y * scale,
  };
}

export const zoomCenter = (camera: Camera, view: Viewport, factor: number): Camera =>
  zoomAt(camera, view, factor, view.width / 2, view.height / 2);

export const pan = (camera: Camera, dx: number, dy: number): Camera => ({
  ...camera,
  tx: camera.tx + dx,
  ty: camera.ty + dy,
});

/** Siralanmis dizide `p` yuzdeligi (0..1); bos dizide 0. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

const ascending = (values: number[]): number[] => values.sort((a, b) => a - b);

/**
 * Gorunur dugumleri sigdiran kamera (ilk acilis ve "gorunumu sifirla").
 * Merkez medyan konumdur (uc degerlerden etkilenmez). Olcek iki sinirdan
 * kucugudur: dugumlerin %95'i merkez dairesine (kisa kenarin FIT_CORE_RATIO'su)
 * ve EN UZAK dugum (yaricapiyla) cerceveye sigar. Boylece seyrek uc dugumler
 * kalabaligi kucultmez ama hicbir dugum cerceve disinda kalmaz.
 */
export function fitCamera(sim: Sim, view: Viewport, flags: ViewFlags): Camera {
  const visible = sim.nodes.filter((node) => isVisible(node, flags));
  const short = Math.min(view.width, view.height);
  if (visible.length === 0 || short <= 0) return INITIAL_CAMERA;

  const cx = percentile(ascending(visible.map((node) => node.x)), 0.5);
  const cy = percentile(ascending(visible.map((node) => node.y)), 0.5);
  const distances = ascending(visible.map((node) => Math.hypot(node.x - cx, node.y - cy)));
  const core = percentile(distances, 0.95);
  let reach = 0;
  for (const node of visible) {
    reach = Math.max(reach, Math.hypot(node.x - cx, node.y - cy) + node.r);
  }

  const fitCore = core > 0 ? (FIT_CORE_RATIO * short) / core : Infinity;
  const fitReach = reach > 0 ? (short / 2 - FIT_FRAME_PAD_PX) / reach : Infinity;
  const scale = Math.min(FIT_MAX_SCALE, Math.max(MIN_SCALE, Math.min(fitCore, fitReach)));
  return { scale, tx: -cx * scale, ty: -cy * scale };
}

/** Imlece en yakin gorunur dugum (isabet payi icinde); yoksa null. */
export function hitTest(
  sim: Sim,
  camera: Camera,
  view: Viewport,
  flags: ViewFlags,
  px: number,
  py: number,
): GNode | null {
  const point = toWorld(camera, view, px, py);
  let best: GNode | null = null;
  let bestDistance = Infinity;
  for (const node of sim.nodes) {
    if (!isVisible(node, flags)) continue;
    const distance = Math.hypot(node.x - point.x, node.y - point.y);
    if (distance <= node.r + HIT_SLOP_PX / camera.scale && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

/** `node` ile dogrudan bagli gorunur dugumler (node'un kendisi dahil degil). */
export function neighborsOf(sim: Sim, node: GNode, flags: ViewFlags): Set<GNode> {
  const near = new Set<GNode>();
  for (const edge of sim.edges) {
    const a = sim.nodes[edge.a];
    const b = sim.nodes[edge.b];
    if (!a || !b) continue;
    if (a === node && isVisible(b, flags)) near.add(b);
    else if (b === node && isVisible(a, flags)) near.add(a);
  }
  return near;
}

/** Bir karenin cizimi icin gereken her sey. */
export interface GraphScene {
  sim: Sim | null;
  camera: Camera;
  view: Viewport;
  flags: ViewFlags;
  selectedId: string | null;
  /** Imlec altindaki dugum: komsulari parlar, digerleri soner. Yoksa null/atlanir. */
  hoveredId?: string | null;
  pixelRatio: number;
}

// --- gorunum sabitleri (palet ve tema mevcut olanla ayni) ---------------------

const EDGE_COLOR = 'rgba(139, 92, 255, 0.3)';
const EDGE_DIM_COLOR = 'rgba(139, 92, 255, 0.05)';
const EDGE_LIT_COLOR = 'rgba(67, 230, 255, 0.75)';
const LABEL_COLOR = 'rgba(243, 238, 255, 0.92)';
const LABEL_SHADOW = 'rgba(8, 3, 20, 0.95)';
const SELECT_COLOR = '#43e6ff';
const HOVER_RING_COLOR = 'rgba(243, 238, 255, 0.85)';
/** Kenar kalinligi ve vurgulu kenar kalinligi (ekran pikseli; yakinlasinca kalinlasmaz). */
const EDGE_PX = 1;
const EDGE_LIT_PX = 1.4;
/** Hover'da komsu olmayan dugumlerin saydamligi. */
const DIM_ALPHA = 0.16;
/** Uzaklasinca dugum bundan (ekran pikseli) kucuk cizilmez. */
const MIN_NODE_PX = 1.3;
const LABEL_PX = 12;
const MEMORY_LABEL_CHARS = 48;

function labelOf(node: GNode, zoomedIn: boolean, emphasized: boolean): string | null {
  if (node.kind === 'hub') return node.label;
  if (node.kind === 'note') {
    return zoomedIn || emphasized ? node.label.replace(/\.md$/i, '') : null;
  }
  if (!emphasized) return null;
  const content = node.record?.content;
  if (!content) return node.label;
  return content.length > MEMORY_LABEL_CHARS ? `${content.slice(0, MEMORY_LABEL_CHARS)}…` : content;
}

/** Hover odagi: odak dugum + komsulari (yoksa grafik normal cizilir). */
interface Focus {
  node: GNode;
  near: Set<GNode>;
}

function focusOf(scene: GraphScene, sim: Sim): Focus | null {
  const node = sim.nodes.find((candidate) => candidate.id === scene.hoveredId);
  if (!node || !isVisible(node, scene.flags)) return null;
  return { node, near: neighborsOf(sim, node, scene.flags) };
}

/** Iki ucu da gorunur olan ve `keep`ten gecen kenarlari tek yolda cizer. */
function strokeEdges(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  flags: ViewFlags,
  keep: (a: GNode, b: GNode) => boolean,
): void {
  ctx.beginPath();
  for (const edge of sim.edges) {
    const a = sim.nodes[edge.a];
    const b = sim.nodes[edge.b];
    if (!a || !b || !isVisible(a, flags) || !isVisible(b, flags) || !keep(a, b)) continue;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  scene: GraphScene,
  focus: Focus | null,
): void {
  const { camera, flags } = scene;
  const touchesFocus = (a: GNode, b: GNode): boolean => a === focus?.node || b === focus?.node;

  ctx.strokeStyle = focus ? EDGE_DIM_COLOR : EDGE_COLOR;
  ctx.lineWidth = EDGE_PX / camera.scale;
  strokeEdges(ctx, sim, flags, (a, b) => !touchesFocus(a, b));

  if (!focus) return;
  ctx.strokeStyle = EDGE_LIT_COLOR;
  ctx.lineWidth = EDGE_LIT_PX / camera.scale;
  strokeEdges(ctx, sim, flags, touchesFocus);
}

/** Renk basina tek yol: yuzlerce dugum tek `fill` ile cizilir (akici kalir). */
function drawNodeGroup(ctx: CanvasRenderingContext2D, nodes: GNode[], scale: number): void {
  const byColor = new Map<string, GNode[]>();
  for (const node of nodes) {
    const group = byColor.get(node.color);
    if (group) group.push(node);
    else byColor.set(node.color, [node]);
  }
  for (const [color, group] of byColor) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const node of group) {
      const r = Math.max(node.r, MIN_NODE_PX / scale);
      ctx.moveTo(node.x + r, node.y);
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  scene: GraphScene,
  focus: Focus | null,
): void {
  const dim: GNode[] = [];
  const lit: GNode[] = [];
  for (const node of sim.nodes) {
    if (!isVisible(node, scene.flags)) continue;
    const isLit = !focus || node === focus.node || focus.near.has(node);
    (isLit ? lit : dim).push(node);
  }
  ctx.globalAlpha = DIM_ALPHA;
  drawNodeGroup(ctx, dim, scene.camera.scale);
  ctx.globalAlpha = 1;
  drawNodeGroup(ctx, lit, scene.camera.scale);
}

/** Etiket kutusunun ekran boyu tahmini: sabit genislikli yazi tipinde karakter basina ~0.6 em. */
const LABEL_CHAR_EM = 0.6;

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Yazilacak etiket: metin ve dugumun soluna mi (sag kenara tasma) saga mi konacagi. */
interface PlacedLabel {
  text: string;
  toLeft: boolean;
}

const overlaps = (a: LabelBox, b: LabelBox): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Hangi dugumun etiketi yazilir: aday etiketler oncelik sirasiyla (odak/secili,
 * hub, buyuk dugum) elenir; ekran disinda kalanlar ve daha onemli bir etiketin
 * ustune binenler yazilmaz. 1100 dugumde yakinlasinca bile okunur kalir.
 */
function readableLabels(sim: Sim, scene: GraphScene, focus: Focus | null): Map<GNode, PlacedLabel> {
  const { camera, view, flags, selectedId } = scene;
  const zoomedIn = camera.scale > NOTE_LABEL_SCALE;
  const candidates: { node: GNode; label: PlacedLabel; priority: number; box: LabelBox }[] = [];
  for (const node of sim.nodes) {
    if (!isVisible(node, flags)) continue;
    const emphasized = node.id === selectedId || node === focus?.node;
    const text = labelOf(node, zoomedIn, emphasized);
    if (!text) continue;
    const width = text.length * LABEL_PX * LABEL_CHAR_EM;
    const gap = node.r * camera.scale + 4;
    const centerX = view.width / 2 + camera.tx + node.x * camera.scale;
    // Sag kenara tasan etiket dugumun soluna alinir (sol da sigmiyorsa saga kalir).
    const toLeft = centerX + gap + width > view.width && centerX - gap - width >= 0;
    const left = toLeft ? centerX - gap - width : centerX + gap;
    const top = view.height / 2 + camera.ty + node.y * camera.scale - 6 - LABEL_PX;
    const box = { left, right: left + width, top, bottom: top + LABEL_PX + 2 };
    const onScreen =
      box.right > 0 && box.left < view.width && box.bottom > 0 && box.top < view.height;
    if (!onScreen) continue;
    const priority = emphasized ? Infinity : node.kind === 'hub' ? 1000 : node.r;
    candidates.push({ node, label: { text, toLeft }, priority, box });
  }
  candidates.sort((a, b) => b.priority - a.priority);
  const placed: LabelBox[] = [];
  const accepted = new Map<GNode, PlacedLabel>();
  for (const { node, label, priority, box } of candidates) {
    // Odak ve secili etiket her zaman yazilir; digerleri yerlesmis olanlarla cakismamali.
    if (priority !== Infinity && placed.some((other) => overlaps(box, other))) continue;
    placed.push(box);
    accepted.set(node, label);
  }
  return accepted;
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  scene: GraphScene,
  focus: Focus | null,
): void {
  const { camera } = scene;
  const labels = readableLabels(sim, scene, focus);
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = `${LABEL_PX / camera.scale}px ui-monospace, monospace`;
  ctx.shadowColor = LABEL_SHADOW;
  ctx.shadowBlur = 4;
  for (const node of sim.nodes) {
    const label = labels.get(node);
    if (!label) continue;
    const offset = (node.r + 4) / camera.scale;
    ctx.textAlign = label.toLeft ? 'right' : 'left';
    ctx.fillText(label.text, node.x + (label.toLeft ? -offset : offset), node.y - 6 / camera.scale);
  }
  ctx.textAlign = 'left';
  ctx.shadowBlur = 0;
}

function drawRing(
  ctx: CanvasRenderingContext2D,
  node: GNode,
  scale: number,
  color: string,
  widthPx: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx / scale;
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.r + 4 / scale, 0, Math.PI * 2);
  ctx.stroke();
}

export function drawGraph(ctx: CanvasRenderingContext2D, scene: GraphScene): void {
  const { sim, camera, view, flags, selectedId, pixelRatio } = scene;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  if (!sim) return;

  ctx.save();
  ctx.translate(view.width / 2 + camera.tx, view.height / 2 + camera.ty);
  ctx.scale(camera.scale, camera.scale);

  const focus = focusOf(scene, sim);
  drawEdges(ctx, sim, scene, focus);
  drawNodes(ctx, sim, scene, focus);
  drawLabels(ctx, sim, scene, focus);

  if (focus && focus.node.id !== selectedId) {
    drawRing(ctx, focus.node, camera.scale, HOVER_RING_COLOR, 1.2);
  }
  const selected = sim.nodes.find((node) => node.id === selectedId);
  if (selected && isVisible(selected, flags)) {
    drawRing(ctx, selected, camera.scale, SELECT_COLOR, 2);
  }
  ctx.restore();
}
