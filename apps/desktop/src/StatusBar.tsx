/**
 * Durum listesi: Smith'in NEYININ acik oldugunu tek bakista gosterir.
 *
 * NEDEN VAR: ses-once arayuzde her sey sese gomulu oldugu icin kullanici
 * "Smith beni duyuyor mu, oturum ayakta mi, hafizaya yazabiliyor mu" sorularini
 * ekrandan CEVAPLAYAMIYORDU. Bu liste o sorulari yazili hale getirir.
 *
 * YERLESIM: kose panosunun (`Hud`) icinde DIKEY okunur bir liste olarak durur:
 * seffaf pencerede yatay chip seridi icin yer yoktu ve gostergeler pet'in
 * uzerine binerdi. Yon karari tamamen hud.css'te, `.hud .signals` altinda.
 *
 * ILKE: UYDURMA YOK. Her satirin degeri ya gercek bir Rust olayindan turer ya
 * da acikca "bilinmiyor" der:
 *
 * - `live` / `pending` / `idle` / `warn` tonlari GERCEK veriden gelir.
 * - `unknown` tonu, cihazda VAR OLAN ama UI'a BILDIRILMEYEN bir sinyali
 *   isaretler (ekran paylasimi, ses izi kapisi). Kesik cizgili gosterilir,
 *   degeri "—" olur ve ayrinti nedenini yazar. Boylece eksik telemetri
 *   GORUNUR olur; sessizce "kapali" gibi okunmaz.
 *
 * Kontrol icermez (kontrol yuzeyi mixer + dinleme dugmesidir; durum listesi
 * salt-okunur kalir). Ayrinti `title` (yalniz fare) yerine acilir `<details>`
 * ile verilir: satir klavyeyle odaklanir, Enter/Bosluk ile acilir ve ayrinti
 * ekran okuyucuya da ulasir.
 */

export type SignalTone =
  /** Olculdu ve acik/saglikli. */
  | 'live'
  /** Bekleniyor (kuruluyor). */
  | 'pending'
  /** Olculdu ve kapali: hata degil. */
  | 'idle'
  /** Olculdu ve sorunlu. */
  | 'warn'
  /** Cihazda var ama UI'a bildirilmiyor: DEGER BILINMIYOR. */
  | 'unknown';

export interface Signal {
  id: string;
  /** Kisa etiket: "Live", "Mikrofon", … */
  label: string;
  /** Gorunen deger. `unknown` tonunda "—" olmali. */
  value: string;
  tone: SignalTone;
  /** Acilir ayrinti: degerin ne anlama geldigi ya da neden bilinmedigi. */
  hint: string;
  /** Ekran okuyucuya okunacak deger; verilmezse `value` okunur. */
  spoken?: string;
}

export interface StatusBarProps {
  signals: Signal[];
}

/** 24x24 cizgi ikonlarinin ortak cercevesi (stroke = `currentColor`). */
function Icon({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/**
 * Satirin KIMLIGI icin sabit, notr bir glif: DURUM degil (o `.sig-dot`'ta).
 * Ikisi birden boyanirsa satir gurultulu olur; ikon hep ayni notr tonda kalir,
 * boylece "hangi renk ne anlatiyor" tek anlamli kalir. El yazimi inline SVG:
 * yeni bir ikon paketi eklemez, 14px'te net kalacak kadar basit tutulur.
 */
const ICONS: Record<string, React.JSX.Element> = {
  link: (
    <Icon>
      <path d="M9 15 15 9" />
      <path d="M11 6l1.5-1.5a3.54 3.54 0 0 1 5 5L16 11" />
      <path d="M13 18l-1.5 1.5a3.54 3.54 0 0 1-5-5L8 13" />
    </Icon>
  ),
  mic: (
    <Icon>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 19v3" />
      <path d="M8 22h8" />
    </Icon>
  ),
  speaker: (
    <Icon>
      <path d="M4 9v6h4l5 5V4L8 9H4z" />
      <path d="M16.5 9.5a4 4 0 0 1 0 5" />
      <path d="M19 7a8 8 0 0 1 0 10" />
    </Icon>
  ),
  screen: (
    <Icon>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </Icon>
  ),
  tool: (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </Icon>
  ),
  memory: (
    <Icon>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </Icon>
  ),
};

export function StatusBar({ signals }: StatusBarProps): React.JSX.Element {
  return (
    <div className="signals" role="group" aria-label="Durum göstergeleri">
      {signals.map((s) => (
        <details key={s.id} className="sig-detail">
          <summary
            className="sig"
            data-tone={s.tone}
            aria-label={`${s.label}: ${s.spoken ?? s.value}`}
          >
            <i className="sig-icon" aria-hidden="true">
              {ICONS[s.id]}
            </i>
            <i className="sig-dot" aria-hidden="true" />
            <span className="sig-label" aria-hidden="true">
              {s.label}
            </span>
            <span className="sig-value" aria-hidden="true">
              {s.value}
            </span>
          </summary>
          <p>{s.hint}</p>
        </details>
      ))}
    </div>
  );
}
