import { useEffect, useRef } from 'react';

import { canvasScale, createCanvasLoop } from './canvasLoop.js';

/**
 * Smith'in yuzu: canli ses dalgasi (canvas).
 *
 * Tasarim kararlari:
 * - Gorsel TAMAMEN gercek sesle surulur (`level` = mikrofon RMS veya Smith'in
 *   konusma etkinligi). Sahte/dekoratif animasyon YOK: ekranda gordugun sey
 *   olan seydir. Sessizken ince bir "nefes" cizgisi kalir.
 * - Katmanli sinus zarflari (5 katman, farkli frekans/faz/renk) additive
 *   ('lighter') karisimla ust uste biner → referans gorseldeki isikli,
 *   birbirine geciyor gorunumu ortaya cikar.
 * - Renk paleti duruma gore doner: DINLIYOR (cyan→mavi) vs SMITH KONUSUYOR
 *   (magenta→mor). Kullanici kimin sirasi oldugunu SESE bakmadan gorur.
 * - Atak/salinim yumusatmasi (attack/release) sart: ham RMS titrek, dogrudan
 *   bagliyinca gorsel sinirli titriyor.
 * - `requestAnimationFrame` + DPR farkindalik; pencere olcegi degisince
 *   yeniden olculur. Gorunmez oldugunda (document hidden) dongu durur —
 *   bataryayi ve CPU'yu bosa yakmaz.
 */

export interface VisualizerProps {
  /** 0..1 anlik ses seviyesi (mic RMS ya da Smith konusurken etkinlik). */
  level: number;
  /** Smith konusuyor mu — renk paletini ve yonu belirler. */
  speaking: boolean;
  /** Mikrofon acik mi; kapaliysa gorsel dinlenmeye ceker. */
  listening: boolean;
}

interface Layer {
  freq: number;
  phase: number;
  speed: number;
  amp: number;
  width: number;
  hueIdle: number;
  hueSpeak: number;
}

const LAYERS: Layer[] = [
  { freq: 1.6, phase: 0.0, speed: 0.55, amp: 1.0, width: 2.4, hueIdle: 190, hueSpeak: 292 },
  { freq: 2.3, phase: 1.1, speed: -0.42, amp: 0.82, width: 2.0, hueIdle: 214, hueSpeak: 315 },
  { freq: 3.1, phase: 2.4, speed: 0.34, amp: 0.62, width: 1.6, hueIdle: 258, hueSpeak: 268 },
  { freq: 4.4, phase: 0.7, speed: -0.28, amp: 0.44, width: 1.3, hueIdle: 168, hueSpeak: 330 },
  { freq: 6.2, phase: 3.0, speed: 0.22, amp: 0.3, width: 1.0, hueIdle: 232, hueSpeak: 284 },
];

export function Visualizer({ level, speaking, listening }: VisualizerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Cizim dongusu React render'indan bagimsiz: prop'lari ref uzerinden okur,
  // boylece her seviye guncellemesinde yeniden render tetiklenmez.
  const invalidate = useRef<() => void>(() => {});
  const inputRef = useRef({ level, speaking, listening });
  inputRef.current = { level, speaking, listening };
  useEffect(() => invalidate.current(), [level, speaking, listening]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dpr = 1;
    // Yumusatilmis seviye + renk gecisi (0 = dinliyor, 1 = Smith konusuyor).
    let smooth = 0;
    let mix = 0;
    let t = 0;

    const resize = (): void => {
      dpr = canvasScale(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      invalidate.current();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = (_now: number, reduced: boolean): void => {
      const { level: lv, speaking: sp, listening: on } = inputRef.current;

      // Atak hizli, salinim yavas: konusma baslarken canli, biterken yumusak.
      const target = on ? Math.min(1, Math.max(0, lv)) : 0;
      smooth += (target - smooth) * (reduced ? 1 : target > smooth ? 0.35 : 0.08);
      mix += ((sp ? 1 : 0) - mix) * (reduced ? 1 : 0.06);
      if (!reduced) t += 1 / 30;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';

      const cx = w / 2;
      const cy = h / 2;
      // Sessizken bile ince bir taban: "olu ekran" hissi olmasin.
      const energy = 0.06 + smooth * 0.94;
      const maxAmp = Math.min(h * 0.34, 190);

      for (const layer of LAYERS) {
        const hue = layer.hueIdle + (layer.hueSpeak - layer.hueIdle) * mix;
        const amp = maxAmp * layer.amp * energy;
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, `hsla(${hue - 24}, 100%, 62%, 0)`);
        grad.addColorStop(0.18, `hsla(${hue - 12}, 100%, 66%, 0.55)`);
        grad.addColorStop(0.5, `hsla(${hue}, 100%, 74%, 0.95)`);
        grad.addColorStop(0.82, `hsla(${hue + 14}, 100%, 66%, 0.55)`);
        grad.addColorStop(1, `hsla(${hue + 26}, 100%, 62%, 0)`);

        ctx.beginPath();
        const step = 2;
        for (let x = 0; x <= w; x += step) {
          const u = (x / w) * 2 - 1; // -1..1
          // Zarf: merkezde genis, kenarlarda sifira giden yumusak pencere.
          const env = Math.pow(Math.cos((u * Math.PI) / 2), 2.2);
          const y =
            cy +
            Math.sin(u * Math.PI * layer.freq + t * layer.speed * 6 + layer.phase) * amp * env +
            Math.sin(u * Math.PI * layer.freq * 2.7 + t * layer.speed * 3.1) * amp * env * 0.22;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = grad;
        ctx.lineWidth = layer.width;
        ctx.shadowBlur = 18 + 26 * energy;
        ctx.shadowColor = `hsla(${hue}, 100%, 66%, 0.75)`;
        ctx.stroke();

        // Ayna katman: referans gorseldeki simetrik "kabarma" hissi.
        ctx.beginPath();
        for (let x = 0; x <= w; x += step) {
          const u = (x / w) * 2 - 1;
          const env = Math.pow(Math.cos((u * Math.PI) / 2), 2.2);
          const y =
            cy -
            Math.sin(u * Math.PI * layer.freq + t * layer.speed * 6 + layer.phase) *
              amp *
              env *
              0.85;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = grad;
        ctx.lineWidth = layer.width * 0.7;
        ctx.stroke();
      }

      // Merkez parlamasi: enerjiyle buyur, sesin "kalbi" hissi.
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(60, 260 * energy));
      const gh = 196 + 100 * mix;
      glow.addColorStop(0, `hsla(${gh}, 100%, 82%, ${0.28 + 0.42 * energy})`);
      glow.addColorStop(1, 'hsla(260, 100%, 60%, 0)');
      ctx.shadowBlur = 0;
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'source-over';
    };
    const loop = createCanvasLoop(
      frame,
      () => inputRef.current.speaking || inputRef.current.level > 0.02,
    );
    invalidate.current = loop.invalidate;
    return () => {
      loop.stop();
      ro.disconnect();
      invalidate.current = () => {};
    };
  }, []);

  return <canvas className="viz" ref={canvasRef} aria-hidden="true" />;
}
