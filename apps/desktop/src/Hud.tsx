import { type ListeningModeState, type ListeningModeControl } from './useOwnerListening.js';
import { Plasma } from '@cruxgarden/plasma-ui';

import { StatusBar, type Signal } from './StatusBar.js';
import { type LinkError } from './linkError.js';
import { type ScreenState, type ScreenStreamControl } from './useScreenStream.js';

/**
 * Kose panosu: E.D.I.T.H./FRIDAY tarzi seffaf HUD'un TEK krom parcasi.
 *
 * NEDEN VAR: pencere artik cercevesiz, seffaf ve her zaman ustte. Boyle bir
 * pencerede iki sorun dogar:
 *  1. Kullanici Smith'in neyinin acik oldugunu goremez (baslik cubugu yok,
 *     gosterge koyacak yer yok) → dikey sinyal listesi burada durur.
 *  2. Isletim sisteminin kapat/kucult dugmeleri YOK → kullanicinin kacis
 *     kapisi da burada olmak zorunda (kapat + normal pencereye don).
 *
 * Bu bilesen SUNUM'dan sorumludur: pencere komutlarini kendisi cagirmaz,
 * App.tsx'ten gelir (tek yer, tek `invoke` sarmalayici).
 *
 * TIKLAMA GECIRGENLIGI: pano etkilesimli bir "ada"dir. Birincil mekanizma
 * geometri bildirimi (`window_set_hit_areas`, useHitAreas.ts); `hover` prop'u
 * yalniz o komut yoksa devreye giren YEDEK yolu tasir ve panonun KOKUNE
 * baglanir: icindeki dugmeler ayrica islem yapmaz.
 *
 * DARALTMA SOZLESMESI: `collapsed` iken yalniz marka + durum satiri + kacis
 * dugmeleri (+ pencere komutu hatasi) kalir; ayrintilarin TUMU tek `collapsed`
 * kosulunun altindadir. Baglanti hatasi daraltilmis panoda da gorunur kalir:
 * ayni metin sahnedeki bildirimde (`.notice`) durur.
 */

/**
 * Mixer (ses karistirici): "mikrofonumu kapat" ve "Smith'in ses duzeyi"
 * AYRI kontroller. Rust tarafindaki mixer durumunun UI izi (`useMixer`);
 * `ready` degilse bolum hic cizilmez (yarim kontrol sunulmaz).
 *
 * YETKI: bu kontroller `audio_stop`u CAGIRMAZ: oturuma dokunmadan mikrofonu
 * ve cikisi yonetir. Tek `dinlemeyi durdur` dugmesi (asagida) hala TUM
 * oturumu kapatir; ikisi bilincli olarak ayri kavramlardir.
 */
export interface MixerProps {
  /** Bir sustur komutu ucta; dugmeler kilitlenir, kaydirici kilitlenmez. */
  pending?: boolean;
  error?: string | null;
  ready: boolean;
  micMuted: boolean;
  outputMuted: boolean;
  outputVolume: number;
  /** Mikrofon seviyesi (0..1; Rust RMS x4, kirpilmis): canli cubuk. */
  micRms: number;
  onToggleMicMute: () => void;
  onToggleOutputMute: () => void;
  onOutputVolume: (volume: number) => void;
}

export interface HudProps {
  signals: Signal[];
  /** Tek satirlik "su an ne yapiyor" (aria-live). Daraltilmis panoda da kalir. */
  state: string;
  /** Mikrofon acik mi: dinleme dugmesinin etiketi ve tonu buna baglidir. */
  listening: boolean;
  /** Tauri host'u var mi; yoksa dinleme dugmesi anlamsizdir (tarayici modu). */
  micReady: boolean;
  /** `audio_start`/`audio_stop` ucta: dinleme dugmesi bekler. */
  micPending?: boolean;
  /** Ucta olan pencere komutlari; ilgili dugmeler beklerken kilitlenir. */
  windowPending?: ReadonlySet<string>;
  /** Son basarisiz pencere komutunun kisa kullanici mesaji. */
  windowError?: string | null;
  onOpenMind?: () => void;
  /** Dokum dugmesi: dokum penceresi kapaninca odagin donecegi yedek yer (App'te tutulur). */
  mindButtonRef?: React.RefObject<HTMLButtonElement | null>;
  /** Ses karistirici (mikrofon kapisi + cikis duzeyi). */
  mixer: MixerProps;
  screen: ScreenState | null;
  screenStream: ScreenStreamControl;
  owner: ListeningModeState | null;
  ownerListening: ListeningModeControl;
  linkError: LinkError | null;
  /** Daraltilmis panoda yalniz marka + durum + dugmeler kalir, ayrintilar gizlenir. */
  collapsed: boolean;
  /** Pencere su an cerceveli mi (`window_state`/`window_toggle_frame`'den). */
  framed: boolean;
  onCollapse: () => void;
  onToggleMic: () => void;
  /** Smith Dashboard'u acar (ayri pencere; gorev panosu o pencerenin bir bolumu, ADR 0007). */
  onOpenMission: () => void;
  /** Panodaki tutamak: pencereyi Rust komutuyla surukler (pet'in yedegi). */
  onGrab: (event: React.PointerEvent<HTMLElement>) => void;
  /** Kacis kapisi 1: cerceveyi ac/kapa (pet modu ↔ normal pencere). */
  onFrame: () => void;
  /** Kacis kapisi 2: uygulamayi kapat. */
  onQuit: () => void;
  hover: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
}

const LISTENING_MODES = [
  ['herkes', 'Herkesi dinle'],
  ['yalniz_beni', 'Yalnız beni dinle'],
  ['isimle', 'Yalnız adımla (oyun modu)'],
] as const;

const SCREEN_STREAM_PRIVACY = 'Live bağlıyken ekran kareleri buluta gönderilir.';

/** Yuzde olarak tam sayi; seviye cubugu ve kaydirici ayni yuvarlamayi kullanir. */
function percent(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

export function Hud(props: HudProps): React.JSX.Element {
  const { collapsed, framed, listening, micReady, signals, state } = props;
  const frameLabel = framed ? 'Çerçeveyi kaldır (pet modu)' : 'Normal pencereye dön';
  const volumePercent = percent(props.mixer.outputVolume);

  /*
   * Kok eleman PLAZMA yuzeyi: pano sivi cam olarak cizilir (WebGL). Dolgu
   * (tint + opacity) `HUD_SURFACE`ten saglayicidan gelir: 13 px metin seffaf
   * pencerede beyaz masaustunun uzerine de dusebilir, bu yuzden dolgu koyu ve
   * neredeyse opaktir (AA kontrasti `mainCss.test.ts`te). `fuse={false}`: pano
   * sabit kromdur, baska yuzeylerle kaynasMAZ. Sinif adi (`.hud`) korunur: Rust
   * hit-alani gozcusu onu olcer.
   */
  return (
    <Plasma
      as="aside"
      className="hud"
      fuse={false}
      radius={16}
      elevation={0.4}
      data-collapsed={collapsed}
      data-on={listening}
      aria-label="Smith durum panosu"
      onPointerEnter={props.hover.onPointerEnter}
      onPointerLeave={props.hover.onPointerLeave}
    >
      <div className="hud-top">
        <span className="mark">
          <i className="pulse" aria-hidden="true" />
          Smith
        </span>

        <div className="hud-tools">
          {/*
            Tutamak. Pet'in kendisi de suruklenir; bu dugme pet gizlendiginde ya
            da kullanici pet'e dokunmak istemediginde ayni komutu verir.
            `onPointerDown` sart: surukleme fare BASILI iken baslar; `onClick`
            ile calismaz.
          */}
          <button
            type="button"
            className="ic"
            onPointerDown={props.onGrab}
            title="Pencereyi taşı"
            aria-label="Pencereyi taşı"
          >
            <span aria-hidden="true">⠿</span>
          </button>
          <button
            type="button"
            className="ic"
            onClick={props.onCollapse}
            title={collapsed ? 'Panoyu aç' : 'Panoyu daralt'}
            aria-label={collapsed ? 'Panoyu aç' : 'Panoyu daralt'}
            aria-expanded={!collapsed}
          >
            <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          </button>
          {/*
            Smith Dashboard ayri bir penceredir; bu dugme onu acar veya
            acikken one getirir. Pet penceresine kanban sigmaz, bkz.
            src-tauri/src/mission.rs.
          */}
          <button
            type="button"
            className="ic"
            disabled={props.windowPending?.has('mission_open')}
            onClick={props.onOpenMission}
            title="Smith Dashboard'u aç"
            aria-label="Smith Dashboard'u aç"
          >
            <span aria-hidden="true">▦</span>
          </button>
          <button
            type="button"
            className="ic"
            data-on={framed}
            disabled={
              props.windowPending?.has('window_toggle_frame') ||
              props.windowPending?.has('window_state')
            }
            onClick={props.onFrame}
            title={frameLabel}
            aria-label={frameLabel}
            aria-pressed={framed}
          >
            <span aria-hidden="true">▢</span>
          </button>
          <button
            type="button"
            className="ic ic-quit"
            disabled={props.windowPending?.has('window_quit')}
            onClick={props.onQuit}
            title="Smith'i kapat"
            aria-label="Smith'i kapat"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>

      {/*
        Su an ne yapiyor: tek satir. `role="status"` = kibar aria-live: ekran
        okuyucu "hafizada ariyor / dinliyor / Smith konusuyor" gecislerini
        duyurur. Pano daraltilsa bile RENDER EDILIR (yalniz gorsel olarak
        kisalir): unmount edilse duyurular sessizce kesilirdi.
      */}
      <p className="hud-state" role="status">
        {state}
      </p>

      {props.windowError ? (
        <p role="alert" className="hud-link-error">
          {props.windowError}
        </p>
      ) : null}
      {collapsed ? null : (
        <>
          {props.linkError ? (
            <p className="hud-link-error" role="status">
              {props.linkError.summary}
            </p>
          ) : null}
          {props.ownerListening.ready ? (
            <div className="mix-row listening-modes" role="group" aria-label="Dinleme kipi">
              {LISTENING_MODES.map(([kip, label]) => (
                <button
                  key={kip}
                  type="button"
                  className="mix-btn"
                  aria-label={label}
                  aria-pressed={props.owner?.kip === kip}
                  disabled={props.ownerListening.pending}
                  onClick={() => props.ownerListening.setMode(kip)}
                  title={
                    kip === 'isimle'
                      ? 'Adla seslen; son gönderimden sonra 15 sn takip penceresi açılır.'
                      : undefined
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          {props.owner?.warning || props.ownerListening.error ? (
            <p className="screen-stream-error" role="alert">
              {props.ownerListening.error ?? 'Ses izi doğrulanamadı. Dinleme kipini kontrol et.'}
            </p>
          ) : null}
          {props.screenStream.ready ? (
            <div className="mix-row screen-stream" data-on={props.screen?.aktif}>
              <span className="mix-label">Ekran akışı</span>
              <span className="screen-stream-state" role="status">
                {props.screen?.aktif ? 'AÇIK' : 'kapalı'}
              </span>
              <button
                type="button"
                className="mix-btn"
                aria-label="Ekran akışı"
                aria-pressed={props.screen?.aktif ?? false}
                disabled={props.screenStream.pending}
                onClick={props.screenStream.toggle}
                title={
                  props.screen?.aktif
                    ? `Ekran akışını kapat. ${SCREEN_STREAM_PRIVACY}`
                    : `Ekran akışını aç. ${SCREEN_STREAM_PRIVACY}`
                }
              >
                {props.screenStream.pending ? 'bekle…' : props.screen?.aktif ? 'kapat' : 'aç'}
              </button>
            </div>
          ) : null}
          {props.screenStream.error ? (
            <p className="screen-stream-error" role="alert">
              {props.screenStream.error}
            </p>
          ) : null}

          <button
            ref={props.mindButtonRef}
            className="hud-mind mix-btn"
            type="button"
            onClick={props.onOpenMind}
          >
            Zihninde ne var
          </button>
          <StatusBar signals={signals} />
          {props.mixer.error ? (
            <p role="alert" className="screen-stream-error">
              {props.mixer.error}
            </p>
          ) : null}
          {props.mixer.ready ? (
            /*
              MIXER: mikrofon ve cikis, oturuma DOKUNMADAN yonetilir. Alttaki
              tek dugme (dinlemeyi durdur) TUM oturumu kapatir; kullanici
              ayrimi istedi: "sustur butonu Smith'i komple disable yapiyor",
              mikrofon ve ses duzeyi ayri kontrol edilmeli.

              Seviye cubugu susturulmusken de DOLAR: mikrofon calisiyor,
              yalnizca oturuma sessizlik gidiyor, "mikrofonum gercekten
              calisiyor mu" sorusunun ekrandan cevabi budur.

              Dugme adi durumu tasir ("Mikrofonu kapat" / "Mikrofonu ac"); ayrica
              `aria-pressed` verilmez, aksi halde ekran okuyucu ayni durumu iki
              kez ve celiskili okurdu.
            */
            <div className="mixer" aria-label="Ses düzeyleri">
              <div className="mix-row">
                <span className="mix-label">Mikrofon</span>
                <span className="mix-meter" aria-hidden="true">
                  <i style={{ width: `${percent(props.mixer.micRms)}%` }} />
                </span>
                <button
                  type="button"
                  className="mix-btn"
                  data-muted={props.mixer.micMuted}
                  disabled={props.mixer.pending}
                  onClick={props.mixer.onToggleMicMute}
                  title={
                    props.mixer.micMuted
                      ? 'Mikrofonu aç (Smith yeniden duyar)'
                      : 'Mikrofonu kapat (Smith duymaz; oturum açık kalır)'
                  }
                  aria-label={props.mixer.micMuted ? 'Mikrofonu aç' : 'Mikrofonu kapat'}
                >
                  {props.mixer.micMuted ? 'aç' : 'kapat'}
                </button>
              </div>
              <div className="mix-row">
                <span className="mix-label">Hoparlör</span>
                {/* Kaydirici beklerken KILITLENMEZ: devre disi kalan girdi suruklemeyi keser. */}
                <input
                  className="mix-vol"
                  type="range"
                  min={0}
                  max={100}
                  value={volumePercent}
                  onChange={(event) => props.mixer.onOutputVolume(Number(event.target.value) / 100)}
                  title={`Ses düzeyi: %${volumePercent}`}
                  aria-label="Smith ses düzeyi"
                  aria-valuetext={`yüzde ${volumePercent}`}
                />
                <button
                  type="button"
                  className="mix-btn"
                  data-muted={props.mixer.outputMuted}
                  disabled={props.mixer.pending}
                  onClick={props.mixer.onToggleOutputMute}
                  title={
                    props.mixer.outputMuted
                      ? 'Sesi aç (Smith yeniden duyulur)'
                      : 'Sesi kapat (oturum etkilenmez)'
                  }
                  aria-label={props.mixer.outputMuted ? 'Sesi aç' : 'Sesi kapat'}
                >
                  {props.mixer.outputMuted ? 'aç' : 'kapat'}
                </button>
              </div>
            </div>
          ) : null}
          {micReady ? (
            <button
              type="button"
              className="hud-mic"
              data-on={listening}
              disabled={props.micPending}
              onClick={props.onToggleMic}
              title={
                listening
                  ? 'Live oturumunu durdurur. Mikrofon ve Smith birlikte susar.'
                  : 'Mikrofonu ve Live oturumunu başlatır.'
              }
            >
              {props.micPending ? 'bekle…' : listening ? 'dinlemeyi durdur' : 'dinlemeye başla'}
            </button>
          ) : null}
        </>
      )}
    </Plasma>
  );
}
