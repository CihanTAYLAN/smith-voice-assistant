import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Group, Text, TextInput } from '@mantine/core';

import { memoryList, vaultGraph } from './api.js';
import { isSettled, pinNode, releaseNode, restart, simulate } from './graphLayout.js';
import { buildGraph, type GNode } from './graphModel.js';
import {
  drawGraph,
  fitCamera,
  hitTest,
  INITIAL_CAMERA,
  isVisible,
  pan,
  zoomAt,
  zoomCenter,
  type Camera,
  type ViewFlags,
  type Viewport,
} from './graphView.js';
import { Fault, faultText } from './LoadView.js';
import { dataOf, useLoadable } from './loadable.js';

/**
 * BILGI GRAFIGI — vault notlari + hafiza kayitlari tek canvas'ta.
 *
 * Model/simulasyon `graphModel.ts`, kamera + cizim + isabet testi `graphView.ts`
 * (saf, Node'da test edilir); burasi React durumu ve etkilesimdir.
 *
 * ERISILEBILIRLIK: canvas yalniz fare icin degildir. Ok tuslari kaydirir, +/-
 * yakinlastirir, Home sifirlar; ayrica her dugum yandaki aranabilir LISTEDE bir
 * dugmedir (secim + "Dosyalar'da ac" klavyeyle yapilir).
 *
 * KAYNAK HATASI GORUNUR: vault ve hafiza ayri yuklenir; biri duserse digeri
 * cizilmeye devam eder ve banda SEBEP yazilir. Ilk yukleme "veri yok" diye
 * gorunmez.
 */

interface Props {
  /** Bir not dugumunden "Dosyalar'da ac" icin. */
  onOpenFile: (path: string) => void;
}

interface Gesture {
  node: GNode | null;
  x: number;
  y: number;
  travel: number;
}

interface Detail {
  title: string;
  body: string;
  path?: string | undefined;
}

const MAX_LISTED = 200;
const DRAG_THRESHOLD_PX = 3;
const PAN_STEP_PX = 40;
const ZOOM_STEP = 1.2;
const WHEEL_ZOOM_IN = 1.12;
const WHEEL_ZOOM_OUT = 0.89;
/** "Yeniden dagit" animasyonunda kare basina simulasyon adimi (~2,5 sn'de oturur). */
const TICKS_PER_FRAME = 2;

function detailOf(node: GNode): Detail {
  if (node.kind === 'note') {
    return { title: node.label, body: node.path ?? 'Dosya yolu kullanılamıyor.', path: node.path };
  }
  if (node.record) {
    return {
      title: `${node.record.sourceType} · ${node.record.sensitivity}`,
      body: node.record.content,
    };
  }
  return { title: `kaynak: ${node.label}`, body: 'Hafıza kaynak grubu' };
}

function listLabel(node: GNode): string {
  if (node.kind === 'mem') return `${node.label}: ${node.record?.content.slice(0, 80) ?? ''}`;
  return node.kind === 'hub' ? `${node.label} (kaynak grubu)` : node.label;
}

function matches(node: GNode, needle: string): boolean {
  return `${node.label} ${node.record?.content ?? ''}`.toLocaleLowerCase('tr').includes(needle);
}

export function Graph({ onOpenFile }: Props): React.JSX.Element {
  const vault = useLoadable(vaultGraph);
  const memory = useLoadable(memoryList);
  const vaultData = dataOf(vault.state);
  const records = dataOf(memory.state)?.records;
  const sim = useMemo(() => buildGraph(vaultData ?? null, records ?? []), [vaultData, records]);
  const counts = useMemo(
    () => ({
      notes: sim.nodes.filter((node) => node.kind === 'note').length,
      memory: sim.nodes.filter((node) => node.kind === 'mem').length,
    }),
    [sim],
  );

  const [flags, setFlags] = useState<ViewFlags>({ notes: true, memory: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera>(INITIAL_CAMERA);
  // Kullanici kamerayi oynatana kadar her cizimde grafik yeniden sigdirilir:
  // ilk acilis, pencere boyutu, gorunurluk dugmesi ve yerlesim animasyonu
  // ayni kurala uyar (bkz. `moveCamera`).
  const autoFit = useRef(true);
  const hovered = useRef<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef(0);

  const readView = useCallback((): Viewport => {
    const stage = stageRef.current;
    return { width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const view = readView();
    const pixelRatio = window.devicePixelRatio || 1;
    const pixelWidth = Math.floor(view.width * pixelRatio);
    const pixelHeight = Math.floor(view.height * pixelRatio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    if (autoFit.current) camera.current = fitCamera(sim, view, flags);
    drawGraph(ctx, {
      sim,
      camera: camera.current,
      view,
      flags,
      selectedId,
      hoveredId: hovered.current,
      pixelRatio,
    });
  }, [sim, flags, selectedId, readView]);

  // Animasyon dongusu en guncel `draw`u cagirir (gorunurluk degisse de eski kare cizilmez).
  const latestDraw = useRef(draw);
  useEffect(() => {
    latestDraw.current = draw;
  }, [draw]);

  // Veri yenilenince yeni simulasyon: kamera yeniden sigdirilir, calisan animasyon biter.
  useEffect(() => {
    autoFit.current = true;
    hovered.current = null;
    return () => cancelAnimationFrame(frame.current);
  }, [sim]);

  // Veri, gorunurluk dugmesi veya secim degisince canvas hemen yeniden cizilir.
  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => latestDraw.current());
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  /** Yerlesimi kare kare surer; oturunca (alpha 0) kendiliginden durur. */
  const settle = (): void => {
    cancelAnimationFrame(frame.current);
    if (sim.alphaTarget === 0 && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      simulate(sim, Infinity); // sogutma sinirli: alpha tabana inince biter
      draw();
      return;
    }
    const step = (): void => {
      simulate(sim, TICKS_PER_FRAME);
      latestDraw.current();
      if (!isSettled(sim)) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };

  /**
   * "Yeniden dagit": simulasyonu tohum konumlardan bastan calistirir. Rastgelelik
   * yok; her seferinde ilk acilistaki sekil olusur. Kamera yeniden sigdirilir.
   */
  const scatter = (): void => {
    restart(sim);
    autoFit.current = true;
    settle();
  };

  // INITIAL_CAMERA "gorunumu sifirla" istegidir: kamera elle degil, yeniden
  // sigdirma ile belirlenir. Baska her kamera kullanicinin elidir; sigdirma durur.
  const moveCamera = (next: Camera): void => {
    autoFit.current = next === INITIAL_CAMERA;
    camera.current = next;
    draw();
  };

  const setHover = (id: string | null): void => {
    if (hovered.current === id) return;
    hovered.current = id;
    draw();
  };

  const canvasPoint = (event: React.PointerEvent<HTMLCanvasElement> | React.WheelEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const point = canvasPoint(event);
    const node = hitTest(sim, camera.current, readView(), flags, point.x, point.y);
    gesture.current = { node, x: event.clientX, y: event.clientY, travel: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (node) {
      autoFit.current = false;
      pinNode(sim, node, node.x, node.y);
      setHover(node.id);
      settle();
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const active = gesture.current;
    if (!active) {
      const point = canvasPoint(event);
      const under = hitTest(sim, camera.current, readView(), flags, point.x, point.y);
      event.currentTarget.style.cursor = under ? 'pointer' : 'default';
      setHover(under?.id ?? null);
      return;
    }
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    active.travel += Math.abs(dx) + Math.abs(dy);
    active.x = event.clientX;
    active.y = event.clientY;
    if (active.node) {
      pinNode(
        sim,
        active.node,
        active.node.x + dx / camera.current.scale,
        active.node.y + dy / camera.current.scale,
      );
      draw();
    } else {
      moveCamera(pan(camera.current, dx, dy));
    }
  };

  const finishGesture = (selectNode: boolean): void => {
    const finished = gesture.current;
    gesture.current = null;
    if (finished?.node) {
      releaseNode(sim, finished.node);
      settle();
      if (selectNode && finished.travel <= DRAG_THRESHOLD_PX) setSelectedId(finished.node.id);
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    finishGesture(true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    const point = canvasPoint(event);
    moveCamera(
      zoomAt(
        camera.current,
        readView(),
        event.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT,
        point.x,
        point.y,
      ),
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>): void => {
    const view = readView();
    const moves = new Map<string, () => Camera>([
      ['ArrowLeft', () => pan(camera.current, PAN_STEP_PX, 0)],
      ['ArrowRight', () => pan(camera.current, -PAN_STEP_PX, 0)],
      ['ArrowUp', () => pan(camera.current, 0, PAN_STEP_PX)],
      ['ArrowDown', () => pan(camera.current, 0, -PAN_STEP_PX)],
      ['+', () => zoomCenter(camera.current, view, ZOOM_STEP)],
      ['=', () => zoomCenter(camera.current, view, ZOOM_STEP)],
      ['-', () => zoomCenter(camera.current, view, 1 / ZOOM_STEP)],
      ['Home', () => INITIAL_CAMERA],
    ]);
    const move = moves.get(event.key);
    if (!move) return;
    event.preventDefault();
    moveCamera(move());
  };

  /** Listeden secilen dugumu isaretler ve gorunumun ortasina getirir. */
  const selectFromList = (node: GNode): void => {
    const { scale } = camera.current;
    setSelectedId(node.id);
    moveCamera({ scale, tx: -node.x * scale, ty: -node.y * scale });
  };

  const toggle = (kind: keyof ViewFlags): void =>
    setFlags((previous) => ({ ...previous, [kind]: !previous[kind] }));

  const reloadAll = (): void => {
    void vault.reload(true);
    void memory.reload(true);
  };

  const loading = vault.state.status === 'loading' || memory.state.status === 'loading';
  const failed = vault.state.status === 'error' && memory.state.status === 'error';
  const needle = filter.trim().toLocaleLowerCase('tr');
  const found = sim.nodes.filter((node) => isVisible(node, flags) && matches(node, needle));
  const selectedNode = sim.nodes.find((node) => node.id === selectedId);
  const detail = selectedNode ? detailOf(selectedNode) : null;
  const detailPath = detail?.path;
  const vaultFault = faultText(vault.state, 'Vault');
  const memoryFault = faultText(memory.state, 'Hafıza');

  return (
    <div className="graph">
      <div className="graph-toolbar">
        <Group gap={6}>
          <Button
            size="sm"
            variant={flags.notes ? 'light' : 'subtle'}
            aria-pressed={flags.notes}
            onClick={() => toggle('notes')}
          >
            notlar ({counts.notes})
          </Button>
          <Button
            size="sm"
            variant={flags.memory ? 'light' : 'subtle'}
            aria-pressed={flags.memory}
            onClick={() => toggle('memory')}
          >
            hafıza ({counts.memory})
          </Button>
          <Button size="sm" variant="subtle" onClick={scatter}>
            yeniden dağıt
          </Button>
          <Button
            size="sm"
            variant="light"
            loading={vault.refreshing || memory.refreshing}
            onClick={reloadAll}
          >
            yenile
          </Button>
        </Group>
        <Text size="xs" c="dimmed" role="status">
          {loading
            ? 'Grafik yükleniyor…'
            : `${counts.notes} not · ${counts.memory} hafıza kaydı${sim.nodes.length === 0 ? ' · Gösterilecek veri yok.' : ''}`}
        </Text>
      </div>

      {vaultFault ? <Fault message={vaultFault} onRetry={() => void vault.reload(true)} /> : null}
      {memoryFault ? (
        <Fault message={memoryFault} onRetry={() => void memory.reload(true)} />
      ) : null}

      <div className="graph-body">
        <div className="graph-nav">
          <TextInput
            size="sm"
            label="Düğüm ara"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
          <ul className="graph-nodes" aria-label="Grafik düğümleri">
            {found.slice(0, MAX_LISTED).map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  className="db-btn"
                  aria-current={node.id === selectedId ? 'true' : undefined}
                  onClick={() => selectFromList(node)}
                >
                  {listLabel(node)}
                </button>
              </li>
            ))}
          </ul>
          {found.length > MAX_LISTED ? (
            <p className="db-hint">
              İlk {MAX_LISTED} düğüm gösteriliyor ({found.length} eşleşme); aramayı daraltın.
            </p>
          ) : null}
        </div>

        <div className="graph-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="graph-canvas"
            tabIndex={0}
            aria-label="Bilgi grafiği. Ok tuşlarıyla kaydır, artı ve eksi ile yakınlaştır, Home ile sıfırla. Düğüm seçmek için soldaki listeyi kullan."
            onKeyDown={onKeyDown}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onPointerCancel={() => finishGesture(false)}
          />
          {sim.nodes.length === 0 ? (
            <p className="graph-empty" aria-hidden="true">
              {loading
                ? 'Grafik yükleniyor…'
                : failed
                  ? 'Grafik verisi alınamadı.'
                  : 'Gösterilecek veri yok.'}
            </p>
          ) : null}

          <div className="graph-zoom" role="group" aria-label="Yakınlaştırma">
            <button
              type="button"
              className="db-ic"
              aria-label="Yakınlaştır"
              title="Yakınlaştır"
              onClick={() => moveCamera(zoomCenter(camera.current, readView(), ZOOM_STEP))}
            >
              +
            </button>
            <button
              type="button"
              className="db-ic"
              aria-label="Uzaklaştır"
              title="Uzaklaştır"
              onClick={() => moveCamera(zoomCenter(camera.current, readView(), 1 / ZOOM_STEP))}
            >
              −
            </button>
            <button
              type="button"
              className="db-ic"
              aria-label="Görünümü sıfırla"
              title="Görünümü sıfırla"
              onClick={() => moveCamera(INITIAL_CAMERA)}
            >
              ⟲
            </button>
          </div>

          {detail ? (
            <section className="graph-detail" aria-label="Düğüm ayrıntısı">
              <div className="graph-detail-head">
                <strong>{detail.title}</strong>
                <button
                  type="button"
                  className="db-ic"
                  onClick={() => setSelectedId(null)}
                  title="Kapat"
                  aria-label="Ayrıntıyı kapat"
                >
                  ×
                </button>
              </div>
              <pre className="graph-detail-body">{detail.body}</pre>
              {detailPath ? (
                <Button size="sm" variant="light" onClick={() => onOpenFile(detailPath)}>
                  Dosyalar’da aç
                </Button>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
