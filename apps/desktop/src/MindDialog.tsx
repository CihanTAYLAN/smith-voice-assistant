import { useModalDialog } from './useModalDialog.js';
import { type MindDump, useMindDump } from './useMindDump.js';

/**
 * "Zihninde ne var": oturum acilirken modele GIDEN baglamin tamami, modal bir
 * pencerede. Kipli davranis (odak tuzagi, Escape, arka plan inertligi, odagi
 * tetikleyiciye geri verme) `useModalDialog`tan gelir; dusunce baloncugu sonup
 * tetikleyici kaybolursa odak panonun "Zihninde ne var" dugmesine doner.
 *
 * `MindDialog` veriyi okur, `MindDialogView` yalniz sunar (dort durum: okunuyor,
 * bos, hata + yeniden dene, hazir).
 */

interface MindDialogProps {
  onClose: () => void;
  /** Dialog'u acan oge kaybolursa odagin gidecegi yer (panodaki dokum dugmesi). */
  fallbackFocus: React.RefObject<HTMLElement | null>;
}

export function MindDialog({ onClose, fallbackFocus }: MindDialogProps): React.JSX.Element {
  const { dump, retry } = useMindDump();
  return (
    <MindDialogView dump={dump} onRetry={retry} onClose={onClose} fallbackFocus={fallbackFocus} />
  );
}

export function MindDialogView({
  dump,
  fallbackFocus,
  onRetry,
  onClose,
}: MindDialogProps & {
  dump: MindDump;
  onRetry: () => void;
}): React.JSX.Element {
  const dialog = useModalDialog(true, onClose, fallbackFocus);

  return (
    <dialog ref={dialog} className="mind-dump" aria-labelledby="mind-title">
      <header className="mind-dump-top">
        <h2 id="mind-title" className="mind-dump-title">
          Zihninde ne var
        </h2>
        <button type="button" className="ic" aria-label="Zihin dökümünü kapat" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <p className="mind-dump-note">
        Oturum için modele gönderilen bağlam. Modelin düşünce izi değildir.
      </p>
      {dump.status === 'loading' ? <p role="status">Bağlam okunuyor…</p> : null}
      {dump.status === 'empty' ? <p role="status">Henüz bağlam bulunmuyor.</p> : null}
      {dump.status === 'error' ? (
        <div role="alert">
          <p>Zihin dökümü okunamadı. Masaüstü bağlantısını kontrol et.</p>
          <button type="button" className="mix-btn" onClick={onRetry}>
            Yeniden dene
          </button>
        </div>
      ) : null}
      {dump.status === 'ready' ? (
        // Kaydirilabilir alan klavyeyle odaklanabilmeli (ok tuslariyla kaydirma).
        <pre className="mind-dump-body" tabIndex={0} role="region" aria-label="Bağlam metni">
          {dump.text}
        </pre>
      ) : null}
    </dialog>
  );
}
