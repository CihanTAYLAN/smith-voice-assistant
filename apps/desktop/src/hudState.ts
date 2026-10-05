import { type ActivityInput, type ActivityState } from './activityState.js';
import { type FaceProps } from './Face.js';
import { type LinkError } from './linkError.js';
import { type Signal } from './StatusBar.js';
import {
  type ActiveTool,
  type LiveLink,
  type MemoryWriteState,
  type ScreenState,
  type ToolRefusal,
} from './useLiveVoice.js';

/**
 * Turetilmis HUD durumu: saf fonksiyonlar (React yok, Tauri yok). Ham durumdan
 * kullaniciya gorunen metni ve tonu burada uretiriz; kullaniciya ASLA ham Rust
 * ya da gateway metni gosterilmez (teknik ayrinti `logFailure` ile gunluge gider).
 */

export interface Notice {
  /** `info` = durum, `fault` = ariza, `gate` = ses izi kapisinin karari. */
  kind: 'fault' | 'info' | 'gate';
  text: string;
}

/**
 * `activityState.ts`teki 10 durumu Face.tsx'in dar prop kumesine tasir.
 * Neredeyse 1:1: tek indirgeme `waiting` ("baglaniyor…"). Baglanti kurulurken
 * yuzun dramatik degismesi plan §6.5'in "durumlar arasi ani gecisten kacin"
 * ilkesiyle celisirdi, idle'in sakin haline yeter.
 */
export function toFaceState(activity: ActivityState): FaceProps['state'] {
  return activity === 'waiting' ? 'idle' : activity;
}

/**
 * Panoda gorunen tek satir. Sira `resolveActivityState`in KENDISIYLE ayni
 * (bkz. o dosya): burada yalniz metne cevriliyor. `tool`/`link` gibi bazi
 * dallarda `activity` tek basina yeterli ayrinti tasimadigi icin (hangi arac,
 * hangi hat alt-durumu) girdi de birlikte okunuyor.
 */
export function sessionState(activity: ActivityState, v: ActivityInput): string {
  if (v.micError) return 'mikrofon sorunu';
  if (activity === 'idle') return 'masaüstü host yok';
  if (activity === 'muted') return 'kapalı';
  const tool = toolSummary(v.tools);
  if (tool) return tool;
  if (activity === 'speaking') return 'Smith konuşuyor';
  if (activity === 'thinking') return 'düşünüyor…';
  if (v.link === 'down') return 'ses hattı kapandı';
  if (activity === 'listening') return 'dinliyor';
  if (v.linkStalled) return 'ses hattı yanıt vermiyor';
  return 'bağlanıyor…';
}

/**
 * Acik araclarin tek satirlik ozeti. Paralel cagri olabilir; ilkini yazip
 * kalanini sayiyla belirtmek satiri kisa tutar.
 */
function toolSummary(tools: ActiveTool[]): string | null {
  const first = tools[0];
  if (!first) return null;
  return tools.length > 1 ? `${first.label} (+${tools.length - 1})` : first.label;
}

interface NoticeInput {
  micError: string | null;
  hostReady: boolean;
  capturing: boolean;
  deviceCount: number;
  link: LiveLink;
  linkStalled: boolean;
  refusal: ToolRefusal | null;
  linkError: LinkError | null;
  playbackNotice: string | null;
}

/**
 * Bos/hatali/engellenmis durumlarin TEK cumlelik aciklamasi. Kural: suclamayan
 * dil, somut sonraki adim, tahmin yok. En kritik olan kazanir; ust uste
 * yigilmaz. Ret nedeni (`refusal.reason`) teknik metindir ve kullaniciya
 * gosterilmez.
 */
export function noticeFor(v: NoticeInput): Notice | null {
  if (v.micError) return { kind: 'fault', text: v.micError };
  if (v.linkError) return { kind: 'fault', text: v.linkError.text };
  if (v.playbackNotice) return { kind: 'info', text: v.playbackNotice };
  if (!v.hostReady) {
    return {
      kind: 'info',
      text: 'Ses masaüstü uygulamasında çalışır; tarayıcı önizlemesinde mikrofon yoktur.',
    };
  }
  if (v.deviceCount === 0) {
    return {
      kind: 'info',
      text: 'Giriş cihazı görünmüyor. Mikrofonu bağladıktan sonra pencereyi yeniden aç.',
    };
  }
  // Ret, ariza degil politika: ayri bir ton. Onemli olan kullanicinin islemin
  // YAPILMADIGINI bilmesi: "reddedildi" geldiyse `bitti` hic gelmez.
  if (v.refusal) {
    return {
      kind: 'gate',
      text: v.refusal.memoryWrite
        ? 'Hafızaya yazılmadı: ses izi doğrulanamadı. İstersen bir daha söyle.'
        : 'Bu işlem çalıştırılmadı: ses izi doğrulanamadı. İstersen bir daha söyle.',
    };
  }
  if (v.capturing && v.link === 'down') {
    return {
      kind: 'fault',
      text: 'Live oturumu kapandı. Dinlemeyi durdurup yeniden başlatmak yeni bir oturum kurar.',
    };
  }
  if (v.capturing && v.linkStalled) {
    return {
      kind: 'info',
      text: 'Ses hattı bir süredir durum bildirmedi; oturum kurulmamış olabilir.',
    };
  }
  return null;
}

interface SignalInput {
  /** Mikrofon/host hazirligi suruyor; "host yok" demek icin erken. */
  initializing: boolean;
  hostReady: boolean;
  capturing: boolean;
  deviceCount: number;
  link: LiveLink;
  linkStalled: boolean;
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  toolCount: number;
  memoryWrite: MemoryWriteState;
  /** Mixer mikrofon kapisi kapali mi (audio://mixer → Rust AudioState). */
  micMuted: boolean;
  /** Mixer cikis susturmasi acik mi ("Hoparlor" satiri). */
  outputMuted: boolean;
  /** Ekran paylasimi durumu; olay hic gelmediyse null (tahmin yok). */
  screen: ScreenState | null;
}

/**
 * Panodaki dikey listeyi kurar. Her satirin kaynagi burada yazili:
 *
 * GERCEK VERI
 *  - Live      ← `audio://live-status` (+ mikrofon acik mi)
 *  - Mikrofon  ← `audio_start/stop` durumu, `audio_devices` listesi,
 *                `audio://vad` (yalniz basamakli hatta gelir)
 *  - Hoparlor  ← `audio://live` asistan parcalari: parca akarken Smith GERCEKTEN
 *                konusuyor (cikis RMS'i UI'a tasinmadigi icin en dogru sinyal)
 *  - Ekran     ← `screen_stream_get` + `audio://screen` + tepsi/sesli arac olaylari
 *  - Arac      ← `audio://tool` (basladi/bitti/reddedildi); paralel cagrilar
 *                sayilir, 30 sn icinde bitmeyen cagri gostergeden duser
 *  - Hafiza    ← `audio://speaker` karari ve `audio://tool` GOZLEMI: bir yazma
 *                cagrisi reddedildiyse kapi kapali, yurutulduyse acik. Gozlem
 *                yoksa "bilinmiyor" der; gozlem 60 sn sonra bayatlar (Rust'ta
 *                karar TTL'i de 60 sn)
 *
 * DEGER UYDURULMAZ: bir sinyal bildirilmediyse "—" ve kesik cizgi ile gosterilir
 * (`unknown` tonu), sessizce "kapali" gibi okunmaz. `hint` metinleri kullaniciya
 * degerin ne anlama geldigini soyler; olay adi gibi teknik ayrinti tasimaz.
 */
export function buildSignals(v: SignalInput): Signal[] {
  return [
    {
      id: 'link',
      label: 'Live',
      value: !v.capturing
        ? 'kapalı'
        : v.link === 'up'
          ? 'bağlı'
          : v.link === 'down'
            ? 'kapandı'
            : v.linkStalled
              ? 'yanıt yok'
              : 'kuruluyor',
      tone: !v.capturing
        ? 'idle'
        : v.link === 'up'
          ? 'live'
          : v.link === 'down' || v.linkStalled
            ? 'warn'
            : 'pending',
      hint: 'Ses bağlantısı. Bağlı olduğunda Smith ses alıp gönderebilir.',
    },
    {
      id: 'mic',
      label: 'Mikrofon',
      value: v.initializing
        ? 'hazırlanıyor'
        : !v.hostReady
          ? 'host yok'
          : v.deviceCount === 0
            ? 'cihaz yok'
            : v.capturing
              ? v.micMuted
                ? 'susturuldu'
                : v.userSpeaking
                  ? 'konuşuyorsun'
                  : 'açık'
              : 'kapalı',
      tone: v.initializing
        ? 'pending'
        : !v.hostReady || v.deviceCount === 0
          ? 'warn'
          : v.capturing
            ? v.micMuted
              ? 'idle'
              : 'live'
            : 'idle',
      hint: 'Mikrofonun durumu. Susturulduğunda ses Smith’e gönderilmez; oturum açık kalır.',
    },
    {
      // Hoparlor = Smith'in SESI su an cikiyor mu. Kullanici mandasi geregi ayri
      // bir satir: "dinliyor" ile "konusuyor" ayni gostergede karisiyordu.
      id: 'speaker',
      label: 'Hoparlör',
      value: v.assistantSpeaking
        ? v.outputMuted
          ? 'susturuldu'
          : 'konuşuyor'
        : v.capturing
          ? 'sessiz'
          : 'kapalı',
      tone: v.assistantSpeaking && !v.outputMuted ? 'live' : 'idle',
      hint: 'Smith’in konuşma etkinliği. Sesi kapatırsan oturum devam eder, yanıtları duymazsın.',
    },
    {
      id: 'screen',
      label: 'Ekran',
      value:
        v.screen === null
          ? '—'
          : v.screen.aktif
            ? v.link === 'up'
              ? v.screen.aralikMs === null
                ? 'akış açık'
                : `akış açık · ${(v.screen.aralikMs / 1000).toFixed(0)} sn`
              : 'açık · bağlantı bekliyor'
            : 'kapalı',
      tone: v.screen === null ? 'unknown' : v.screen.aktif ? 'live' : 'idle',
      ...(v.screen === null ? { spoken: 'durum henüz bildirilmedi' } : {}),
      hint:
        v.screen === null
          ? 'Ekran akışı durumu henüz okunamadı.'
          : v.screen.aktif
            ? 'Ekran akışı açık. Live bağlıyken ekran kareleri buluta gönderilir. HUD, tepsi veya sesli komutla kapatabilirsin.'
            : 'Sürekli ekran akışı kapalı. Açarsan Live bağlıyken ekran kareleri buluta gönderilir. HUD, tepsi veya sesli komutla açabilirsin.',
    },
    {
      id: 'tool',
      label: 'Araç',
      value: v.toolCount === 0 ? 'boşta' : v.toolCount === 1 ? 'çalışıyor' : `${v.toolCount} araç`,
      tone: v.toolCount > 0 ? 'live' : 'idle',
      hint: 'Şu anda çalışan araçların sayısı. Yapılan işlem üstteki durum satırında gösterilir.',
    },
    {
      id: 'memory',
      label: 'Hafıza',
      value:
        v.memoryWrite === 'blocked'
          ? 'yazma bloke'
          : v.memoryWrite === 'allowed'
            ? 'yazma açık'
            : '—',
      tone: v.memoryWrite === 'blocked' ? 'warn' : v.memoryWrite === 'allowed' ? 'live' : 'unknown',
      ...(v.memoryWrite === 'unknown' ? { spoken: 'henüz gözlem yok' } : {}),
      hint:
        v.memoryWrite === 'unknown'
          ? 'Hafızaya yazma ses izi doğrulamasına bağlı: doğrulanamazsa BLOKE kalır. Bu oturumda henüz bir yazma denemesi gözlenmedi, bu yüzden tahmin etmiyoruz.'
          : 'Son gözlenen ses izi veya hafızaya yazma kararı. 60 saniye sonra bayat sayılır ve "bilinmiyor"a döner.',
    },
  ];
}
