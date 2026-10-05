import { useEffect, useRef } from 'react';

import { canvasScale, createCanvasLoop } from './canvasLoop.js';
import './face.css';

/**
 * Smith'in yuzu — AURA: yuzey gerilimi olan sivi bir damla.
 *
 * Kimlik (konsept 01, 2026-09-25 secimi): pet bir robot kafasi degil, plasma
 * deck ile ayni malzemeden canli bir kuredir. Duygu; seklin kipirtisi, rengin
 * kaymasi ve icinde gezen isikla okunur. Gozler iceriden yanan iki isik,
 * agiz ince bir gerilim cizgisi.
 *
 * Neden TEK canvas (SVG+canvas karisimi degil):
 * - Onceki kimlik (Vector tarzi kafa) statik govde + dinamik LED'lerdi;
 *   bolunme dogaldi. AURA'da GOVDENIN KENDISI her karede yeniden sekillenir
 *   (yuzey gerilimi dalgasi) — statik katman kalmadi. Tek canvas, tek cizim
 *   gecisi, tek zaman t.
 * - Cizim maliyeti kucuk: ~72 noktali blob yolu + birkac radyal gradyan.
 *   Pet penceresi ~300px; bu yuk 60 Hz'de olculemez.
 *
 * Neden lerp (yumusatma): `state` ayrik bir prop; dogrudan uygulanirsa renk
 * ve poz ZIPLAR. Organizma hissi gecislerin kendisinde: her poz parametresi
 * poza dogru KAYAR. `approach()` katsayiyi gercek dt ile yeniden olcekler —
 * his, ekranin tazeleme hizindan bagimsizdir.
 */

export interface FaceProps {
  /**
   * Asistanin durumu; ifadeyi ve rengi belirler. `reading`/`researching`/
   * `acting` `activityState.ts`teki GERCEK arac kategorilerinden gelir (uydurma
   * degil — bkz. o dosyanin basindaki not); `muted`/`error` de dogrudan
   * olculen olgular (mikrofon kapali / cihaz-ariza-hat koptu).
   */
  state:
    | 'idle'
    | 'listening'
    | 'thinking'
    | 'reading'
    | 'researching'
    | 'acting'
    | 'speaking'
    | 'muted'
    | 'error';
  /** 0..1 anlik ses seviyesi (dinlerken mikrofon RMS, konusurken cikis etkinligi). */
  level: number;
}

type FaceState = FaceProps['state'];

/* --- pozlar -------------------------------------------------------------- */

interface Pose {
  /** Goz olcegi (1 = normal). Kirpmadan bagimsiz durum kisisalligi. */
  eyeW: number;
  eyeH: number;
  /** Bakis kaymasi: -1..1 (blob yaricapina oranlanir). */
  gazeX: number;
  gazeY: number;
  /** Agiz kavisi: -1 (asagi/uzgun) .. +1 (yukari/gulumseme). */
  mouth: number;
  /** Agzin taban acikligi 0..1; konusurken `level` uzerine biner. */
  open: number;
  /** Yuzey gerilimi dalgasinin siddeti (1 = sakin nefes). */
  wobble: number;
  /** Icerideki isigin girdap hizi: dusunurken doner, bosteyse suruklenir. */
  swirl: number;
  /** Nefes saliniminin agirligi. */
  breath: number;
  /** Genel isik kazanci (halo + goz parlamasi). */
  glow: number;
  /** Yorunge damlaciginin belirginligi 0..1. */
  sat: number;
  /** Baskin durum rengi. styles.css degiskenlerinin RGB karsiliklari:
   *  --cyan #43e6ff, --violet #8b5cff, --magenta #ff5cf0, --danger #ff665c.
   *  Govde/halo/halka renkleri her karede bundan turetilir. */
  rgb: readonly [number, number, number];
}

const POSES: Record<FaceState, Pose> = {
  // Sakin: tam ortada bakan gozler, en yavas dalga, hafif gulumseme.
  idle: {
    eyeW: 1,
    eyeH: 1,
    gazeX: 0,
    gazeY: 0,
    mouth: 0.35,
    open: 0,
    wobble: 1,
    swirl: 0.15,
    breath: 1,
    glow: 0.85,
    sat: 0.8,
    rgb: [110, 200, 255],
  },
  // Dikkat: gozler acilir, renk saf cyan'a gider, yuzey sakinlesir (dinliyor).
  listening: {
    eyeW: 1.06,
    eyeH: 1.16,
    gazeX: 0,
    gazeY: -0.06,
    mouth: 0.15,
    open: 0,
    wobble: 0.55,
    swirl: 0.1,
    breath: 0.5,
    glow: 1,
    sat: 1,
    rgb: [67, 230, 255],
  },
  // Dusunme: bakis yukari-yana kacar, gozler kisilir, ic isik GIRDAP yapar.
  thinking: {
    eyeW: 0.9,
    eyeH: 0.62,
    gazeX: 0.34,
    gazeY: -0.3,
    mouth: 0.05,
    open: 0,
    wobble: 0.8,
    swirl: 1,
    breath: 0.3,
    glow: 0.85,
    sat: 0.9,
    rgb: [139, 92, 255],
  },
  // Konusma: magenta, agiz acilir (ses seviyesiyle oynar), yuzey dalgalanir.
  speaking: {
    eyeW: 1,
    eyeH: 0.88,
    gazeX: 0,
    gazeY: 0.05,
    mouth: 0.55,
    open: 0.3,
    wobble: 1.2,
    swirl: 0.25,
    breath: 0.4,
    glow: 1.05,
    sat: 1,
    rgb: [255, 92, 240],
  },
  // Okuma: SAF yatay tarama — bakis satir satir gezinir gibi yana kayar
  // (kare dongusunde sinusle surulur); thinking'in koseye kacisindan ayri.
  reading: {
    eyeW: 0.96,
    eyeH: 0.68,
    gazeX: 0,
    gazeY: 0.04,
    mouth: 0.1,
    open: 0,
    wobble: 0.4,
    swirl: 0.1,
    breath: 0.35,
    glow: 0.85,
    sat: 0.7,
    rgb: [95, 205, 250],
  },
  // Arastirma: bakis iki eksende dolanir (arayan bakis), girdap yarim hizda.
  researching: {
    eyeW: 0.88,
    eyeH: 0.7,
    gazeX: 0.26,
    gazeY: -0.18,
    mouth: 0.08,
    open: 0,
    wobble: 0.6,
    swirl: 0.5,
    breath: 0.3,
    glow: 0.88,
    sat: 0.85,
    rgb: [120, 160, 255],
  },
  // Eylem: bakis ONE/asagi (ise odaklanmis), yuzey enerjik, parlak "islem".
  acting: {
    eyeW: 1,
    eyeH: 0.9,
    gazeX: 0.12,
    gazeY: 0.1,
    mouth: 0.25,
    open: 0.05,
    wobble: 0.9,
    swirl: 0.35,
    breath: 0.4,
    glow: 0.95,
    sat: 0.9,
    rgb: [180, 110, 255],
  },
  // Susturuldu: kucuk, sonuk, dusuk enerji — "kapali" degil, "dinleniyor".
  muted: {
    eyeW: 0.92,
    eyeH: 0.42,
    gazeX: 0,
    gazeY: 0.14,
    mouth: 0.02,
    open: 0,
    wobble: 0.25,
    swirl: 0.05,
    breath: 0.5,
    glow: 0.35,
    sat: 0.35,
    rgb: [120, 128, 168],
  },
  // Ariza: dogrudan bakis (dikkat pozu), hafif asagi kavis. Renk panodaki
  // --danger ile AYNI (#ff665c) — ayni anlam iki yuzeyde ayni ton. Dalga
  // BILINCLI dusuk: "no flashing" — alarm titrek degil, sakin ve belirgin.
  error: {
    eyeW: 1,
    eyeH: 0.92,
    gazeX: 0,
    gazeY: 0,
    mouth: -0.3,
    open: 0,
    wobble: 0.3,
    swirl: 0.08,
    breath: 0.25,
    glow: 0.9,
    sat: 0.6,
    rgb: [255, 102, 92],
  },
};

/* --- yardimcilar --------------------------------------------------------- */

/**
 * Kare hizindan bagimsiz yumusatma. `per60`, 60 Hz'de kare basina alinacak
 * yol orani; gercek dt ile yeniden olceklenir.
 */
function approach(from: number, to: number, per60: number, dt: number): number {
  return from + (to - from) * (1 - Math.pow(1 - per60, dt * 60));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Iki RGB rengi karistirir (k=0 → a, k=1 → b). */
function mix(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  k: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function rgba(c: readonly [number, number, number], a: number): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
}

/* Kimlik sabitleri (konsept kartindaki palet). */
const ICE: readonly [number, number, number] = [234, 252, 255]; // cekirdek parlama
const DEEP: readonly [number, number, number] = [26, 10, 56]; // #1a0b38 damla dibi
const CYAN: readonly [number, number, number] = [67, 230, 255];
const MAGENTA: readonly [number, number, number] = [255, 92, 240];

/** Blob cevresi cozunurlugu: 72 nokta kavisleri pürüzsüz tutar. */
const SEGMENTS = 72;

/* --- bilesen ------------------------------------------------------------- */

export function Face({ state, level }: FaceProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Cizim dongusu React render'indan bagimsiz calisir: prop'lari ref uzerinden
  // okur, boylece her seviye guncellemesi yeniden render tetiklemez.
  const invalidate = useRef<() => void>(() => {});
  const inputRef = useRef({ state, level });
  inputRef.current = { state, level };
  useEffect(() => invalidate.current(), [state, level]);

  // Kirpma zamanlamasi effect icindeki zamanlayicida uretilir; render sirasinda
  // `Math.random()` cagirmak StrictMode'da iki kez calisir ve deterministik
  // olmayan render demektir.
  const blinkRef = useRef({ start: -1, dur: 110 });
  // Goz kirpma: 4-7 sn'de bir, 90-140 ms. Nadiren cift kirpma — canlilik
  // hissi bu duzensizlikten geliyor, sabit periyot robotik durur.
  useEffect(() => {
    let timer = 0;
    const fire = (): void => {
      const dur = 90 + Math.random() * 50;
      blinkRef.current = { start: performance.now(), dur };
      const next = Math.random() < 0.12 ? dur + 130 : 4000 + Math.random() * 3000;
      timer = window.setTimeout(fire, next);
    };
    timer = window.setTimeout(fire, 2200 + Math.random() * 2800);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let last = performance.now();
    let t = 0;

    // Yumusatilmis calisma durumu. Baslangic: idle pozu (ilk kare ziplamasin).
    const start = POSES.idle;
    const cur = {
      eyeW: start.eyeW,
      eyeH: start.eyeH,
      gazeX: 0,
      gazeY: 0,
      mouth: start.mouth,
      open: start.open,
      wobble: start.wobble,
      swirl: start.swirl,
      breath: start.breath,
      glow: start.glow,
      sat: start.sat,
      r: start.rgb[0],
      g: start.rgb[1],
      b: start.rgb[2],
      lvl: 0,
      listen: 0,
      speak: 0,
    };

    const resize = (): void => {
      const dpr = canvasScale(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio);
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

    /** Yuzey gerilimli damla yolu: yaricap birkac harmonik sinusle modullenir. */
    const blobPath = (
      cx: number,
      cy: number,
      radius: number,
      a2: number,
      a3: number,
      a5: number,
    ): void => {
      const p2 = t * 0.7;
      const p3 = -t * 1.1;
      const p5 = t * 1.9;
      ctx.beginPath();
      for (let i = 0; i <= SEGMENTS; i += 1) {
        const th = (i / SEGMENTS) * Math.PI * 2;
        const rr =
          radius *
          (1 +
            a2 * Math.sin(2 * th + p2) +
            a3 * Math.sin(3 * th + p3) +
            a5 * Math.sin(5 * th + p5));
        const x = cx + Math.cos(th) * rr;
        const y = cy + Math.sin(th) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    const frame = (now: number, reduced: boolean): void => {
      // dt sinirli: sekmeye geri donuldugunde tek karede sicrama olmasin.
      const dt = reduced ? 1 : Math.min(0.1, Math.max(0.004, (now - last) / 1000));
      last = now;
      if (!reduced) t += dt;

      const input = inputRef.current;
      const pose = POSES[input.state];
      const motion = reduced ? 0 : 1;

      const raw = Number.isFinite(input.level) ? clamp01(input.level) : 0;
      // Atak hizli, salinim yavas: ham RMS titrek, dogrudan baglanirsa damla
      // sinirli titrer.
      cur.lvl = approach(cur.lvl, raw, raw > cur.lvl ? 0.35 : 0.09, dt);

      // Bakis hedefi: okuma saf yatay TARAMA; arastirma iki eksende dolanma;
      // digerleri poz bakisinin etrafinda hafif gezinme (sabit aci "donmus"
      // gorunur).
      let gazeX: number;
      let gazeY: number;
      if (input.state === 'reading') {
        gazeX = 0.3 * Math.sin(t * 1.6) * motion;
        gazeY = pose.gazeY;
      } else if (input.state === 'researching') {
        gazeX = pose.gazeX * Math.sin(t * 0.55) * motion;
        gazeY = pose.gazeY + 0.14 * Math.sin(t * 0.37 + 1.4) * motion;
      } else {
        gazeX = pose.gazeX * (0.78 + 0.3 * Math.sin(t * 0.55) * motion);
        gazeY = pose.gazeY * (0.85 + 0.2 * Math.sin(t * 0.37 + 1.4) * motion);
      }

      // Poz gecisi ~0.25 sn'de oturur (60 Hz'de kare basina %9): daha hizlisi
      // ziplama, daha yavasi uyusuk hissettiriyor.
      const K = 0.09;
      cur.eyeW = approach(cur.eyeW, pose.eyeW, K, dt);
      cur.eyeH = approach(cur.eyeH, pose.eyeH, K, dt);
      cur.gazeX = approach(cur.gazeX, gazeX, K, dt);
      cur.gazeY = approach(cur.gazeY, gazeY, K, dt);
      cur.mouth = approach(cur.mouth, pose.mouth, K, dt);
      cur.open = approach(cur.open, pose.open, 0.12, dt);
      cur.wobble = approach(cur.wobble, pose.wobble, 0.06, dt);
      cur.swirl = approach(cur.swirl, pose.swirl, 0.06, dt);
      cur.breath = approach(cur.breath, pose.breath, 0.06, dt);
      cur.glow = approach(cur.glow, pose.glow, 0.08, dt);
      cur.sat = approach(cur.sat, pose.sat, 0.06, dt);
      // Renk daha yavas doner: ani renk sicramasi en cok goze batan gecis.
      cur.r = approach(cur.r, pose.rgb[0], 0.06, dt);
      cur.g = approach(cur.g, pose.rgb[1], 0.06, dt);
      cur.b = approach(cur.b, pose.rgb[2], 0.06, dt);
      cur.listen = approach(cur.listen, input.state === 'listening' ? 1 : 0, 0.07, dt);
      cur.speak = approach(cur.speak, input.state === 'speaking' ? 1 : 0, 0.07, dt);

      const accent: [number, number, number] = [cur.r, cur.g, cur.b];
      const speakLvl = cur.speak * cur.lvl;
      const listenLvl = cur.listen * cur.lvl;

      // Nefes: hacim korunan squash-stretch — sivi hissinin yarisi burada.
      const br = Math.sin(t * 0.85) * 0.032 * cur.breath * motion;
      const scaleX = 1 + br;
      const scaleY = 1 - br;

      // Kirpma: kapanma acilmadan hizli (mekanik goz kapagi hissi).
      let eyeOpen = 1;
      const bl = blinkRef.current;
      if (bl.start >= 0) {
        const p = (now - bl.start) / bl.dur;
        if (p >= 1) blinkRef.current = { start: -1, dur: bl.dur };
        else {
          const c = p < 0.42 ? p / 0.42 : 1 - (p - 0.42) / 0.58;
          const s = c * c * (3 - 2 * c); // smoothstep
          eyeOpen = 1 - s * 0.97;
        }
      }
      const dim = eyeOpen < 0.2 ? 0.55 + eyeOpen * 2 : 1;

      // Geometri: damla kutunun kisa kenarina oranlanir; uydu ve golge icin
      // kenarlarda pay birakilir.
      const R = Math.min(w, h) * 0.33;
      const cx = w / 2;
      const cy = h * 0.47;
      const glowGain = cur.glow * dim * (1 + 0.35 * listenLvl + 0.25 * speakLvl);

      ctx.clearRect(0, 0, w, h);

      /* 1) Zemin golgesi: damlayi havada birakmaz. */
      ctx.save();
      ctx.translate(cx, cy + R * 1.3);
      ctx.scale(1, 0.24);
      const sh = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R * 1.05);
      sh.addColorStop(0, 'rgba(2,0,10,0.5)');
      sh.addColorStop(1, 'rgba(2,0,10,0)');
      ctx.fillStyle = sh;
      ctx.fillRect(-R * 1.1, -R * 1.1, R * 2.2, R * 2.2);
      ctx.restore();

      /* 2) Halo: durum renginde nefes alan isik atmosferi. */
      const halo = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R * 1.85);
      halo.addColorStop(0, rgba(accent, 0.26 * glowGain));
      halo.addColorStop(0.55, rgba(accent, 0.1 * glowGain));
      halo.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(cx - R * 1.9, cy - R * 1.9, R * 3.8, R * 3.8);

      /* 3) Yorunge damlacigi: organizmanin uydusu — durumu uzaktan okutur. */
      if (cur.sat > 0.02) {
        const orbA = t * (0.4 + 0.5 * cur.swirl) * motion + 1.2;
        const sx = cx + Math.cos(orbA) * R * 1.24;
        const sy = cy + Math.sin(orbA) * R * 1.12;
        const sr = R * 0.11 * (0.85 + 0.15 * Math.sin(t * 2.1) * motion);
        const sa = cur.sat;
        const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 2.6);
        sg.addColorStop(0, rgba(accent, 0.3 * sa * glowGain));
        sg.addColorStop(1, rgba(accent, 0));
        ctx.fillStyle = sg;
        ctx.fillRect(sx - sr * 2.6, sy - sr * 2.6, sr * 5.2, sr * 5.2);
        const sb = ctx.createRadialGradient(sx - sr * 0.3, sy - sr * 0.3, 0, sx, sy, sr);
        sb.addColorStop(0, rgba(mix(ICE, accent, 0.3), 0.95 * sa));
        sb.addColorStop(0.6, rgba(accent, 0.8 * sa));
        sb.addColorStop(1, rgba(mix(accent, DEEP, 0.5), 0.75 * sa));
        ctx.fillStyle = sb;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();
      }

      /* 4-6) Damla govde: nefes olcegi altinda cizilir. */
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scaleX, scaleY);
      ctx.translate(-cx, -cy);

      // Konusurken sesin nabzi yuksek harmonige vurur (yuzey dalgalanir).
      const a2 = 0.016 * cur.wobble * motion;
      const a3 = 0.012 * cur.wobble * motion;
      const a5 = (0.007 * cur.wobble + 0.028 * speakLvl) * motion;
      blobPath(cx, cy, R, a2, a3, a5);

      // 4) Govde dolgusu: sol-ustten isik alan radyal derinlik.
      const gx = cx - R * 0.2;
      const gy = cy - R * 0.24;
      const body = ctx.createRadialGradient(gx, gy, R * 0.05, cx, cy, R * 1.08);
      body.addColorStop(0, rgba(mix(ICE, accent, 0.3), 0.98));
      body.addColorStop(0.34, rgba(accent, 0.96));
      body.addColorStop(0.72, rgba(mix(accent, DEEP, 0.55), 0.97));
      body.addColorStop(1, rgba(DEEP, 0.98));
      ctx.fillStyle = body;
      ctx.fill();

      // 5) Ic girdap: damlanin icinde gezinen isik. Dusunurken hizli doner —
      // "kafa yoruyor" hissi; bosteyse agir suruklenir (canli doku).
      ctx.save();
      ctx.clip(); // blobPath hala aktif yol
      const swA = t * 1.25 * cur.swirl * motion;
      const swx = cx + Math.cos(swA) * R * 0.5;
      const swy = cy + Math.sin(swA * 0.8) * R * 0.45;
      const sw = ctx.createRadialGradient(swx, swy, 0, swx, swy, R * 1.35);
      sw.addColorStop(0, rgba(ICE, 0.16 * cur.swirl * glowGain));
      sw.addColorStop(0.5, rgba(accent, 0.1 * cur.swirl));
      sw.addColorStop(1, rgba(accent, 0));
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = sw;
      ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);
      // Karsi yonde ikinci, zayif girdap: derinlik icin.
      const sw2x = cx - Math.cos(swA * 0.6) * R * 0.55;
      const sw2y = cy - Math.sin(swA * 0.6) * R * 0.4;
      const sw2 = ctx.createRadialGradient(sw2x, sw2y, 0, sw2x, sw2y, R * 1.1);
      sw2.addColorStop(0, rgba(mix(accent, MAGENTA, 0.5), 0.08 * cur.swirl));
      sw2.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = sw2;
      ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();

      // 6) Kenar halkasi: aurora rim (cyan → durum rengi → magenta).
      blobPath(cx, cy, R, a2, a3, a5);
      const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      rim.addColorStop(0, rgba(mix(accent, CYAN, 0.55), 0.85));
      rim.addColorStop(0.5, rgba(accent, 0.7));
      rim.addColorStop(1, rgba(mix(accent, MAGENTA, 0.5), 0.85));
      ctx.strokeStyle = rim;
      ctx.lineWidth = Math.max(1.5, R * 0.022);
      ctx.stroke();

      // 7) Specular: sol-ustte yumusak parlama — yuzeyin "islak" okunmasi.
      ctx.save();
      ctx.translate(cx - R * 0.34, cy - R * 0.4);
      ctx.rotate(-0.4);
      ctx.scale(1, 0.5);
      const spec = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.34);
      spec.addColorStop(0, `rgba(255,255,255,${0.4 * glowGain})`);
      spec.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = spec;
      ctx.fillRect(-R * 0.36, -R * 0.36, R * 0.72, R * 0.72);
      ctx.restore();

      /* 8) Gozler: iceriden yanan iki isik. Once renkli hale, uzerine beyaz
         cekirdek; additive karisim gercek bloom toplamasi verir. */
      const eyeR = R * 0.15;
      const eyeDX = R * 0.34;
      const eyeY = cy - R * 0.08;
      ctx.globalCompositeOperation = 'lighter';
      for (let e = 0; e < 2; e += 1) {
        const ex = cx + (e === 0 ? -eyeDX : eyeDX) + cur.gazeX * R * 0.2;
        const ey = eyeY + cur.gazeY * R * 0.22;
        const rw = eyeR * cur.eyeW;
        const rh = Math.max(eyeR * cur.eyeH * eyeOpen, eyeR * 0.06);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.scale(rw / eyeR, rh / eyeR);
        const glowR = eyeR * (2.3 + 0.7 * listenLvl);
        const eg = ctx.createRadialGradient(0, 0, eyeR * 0.1, 0, 0, glowR);
        eg.addColorStop(0, rgba(mix(ICE, accent, 0.4), 0.5 * glowGain));
        eg.addColorStop(0.45, rgba(accent, 0.18 * glowGain));
        eg.addColorStop(1, rgba(accent, 0));
        ctx.fillStyle = eg;
        ctx.fillRect(-glowR, -glowR, glowR * 2, glowR * 2);
        const core = ctx.createRadialGradient(0, 0, 0, 0, 0, eyeR * 0.62);
        core.addColorStop(0, `rgba(255,255,255,${0.95 * Math.min(1, glowGain)})`);
        core.addColorStop(0.7, rgba(mix(ICE, accent, 0.25), 0.85 * glowGain));
        core.addColorStop(1, rgba(accent, 0));
        ctx.fillStyle = core;
        ctx.fillRect(-eyeR * 0.66, -eyeR * 0.66, eyeR * 1.32, eyeR * 1.32);
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';

      /* 9) Agiz: kapaliyken ince gerilim cizgisi; konusurken seviyeyle acilan
         koyu bir bosluk. Iki form `cur.open` ile birbirine karisir. */
      const mouthY = cy + R * 0.42;
      const mouthW = R * 0.38;
      const openEff = clamp01(cur.open + 0.55 * speakLvl);
      const curve = cur.mouth * (0.8 + 0.3 * speakLvl);
      if (openEff > 0.06) {
        const mh = R * 0.16 * openEff;
        ctx.save();
        ctx.translate(cx, mouthY + curve * R * 0.04);
        ctx.beginPath();
        ctx.ellipse(0, 0, mouthW * (0.5 + 0.2 * openEff), mh, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10,4,26,0.88)';
        ctx.fill();
        ctx.strokeStyle = rgba(mix(accent, ICE, 0.4), 0.45 * glowGain);
        ctx.lineWidth = Math.max(1, R * 0.014);
        ctx.stroke();
        ctx.restore();
      }
      if (openEff < 0.85) {
        const lineA = (1 - openEff / 0.85) * 0.75 * Math.min(1, glowGain + 0.15);
        if (lineA > 0.02) {
          ctx.beginPath();
          ctx.moveTo(cx - mouthW, mouthY);
          ctx.quadraticCurveTo(cx, mouthY + curve * R * 0.22, cx + mouthW, mouthY);
          ctx.strokeStyle = rgba(mix(ICE, accent, 0.3), lineA);
          ctx.lineWidth = Math.max(1.4, R * 0.03);
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      }

      ctx.restore(); // nefes olcegi
    };
    const loop = createCanvasLoop(
      frame,
      () =>
        inputRef.current.level > 0.02 ||
        !['idle', 'muted', 'listening'].includes(inputRef.current.state),
    );
    invalidate.current = loop.invalidate;
    return () => {
      loop.stop();
      ro.disconnect();
      invalidate.current = () => {};
    };
  }, []);

  return (
    <div className="face" data-state={state} aria-hidden="true">
      <div className="face-float">
        <canvas className="face-canvas" ref={canvasRef} />
      </div>
    </div>
  );
}
