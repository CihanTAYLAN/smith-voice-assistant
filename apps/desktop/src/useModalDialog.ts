import { useEffect, useRef } from 'react';

/**
 * Yerel `<dialog>` ile kipli yuzey (cekmece, form, onay, dokum): TEK yardimci,
 * uc pencere de bunu kullanir (ana pencere zihin dokumu, Dashboard'un
 * kaydedilmemis degisiklik sorusu, Mission Control formlari). `open` iken
 * `showModal()`: odak tuzagi, Escape ve arka planin inert olmasi tarayicidan
 * gelir; ozel tuzak yazilmaz. Kapaninca odak, pencereyi acan ogeye doner.
 *
 * Escape ve yerel kapanis `onClose` ile bildirilir; `open` durumunun TEK sahibi
 * ust bilesendir. Acan oge DOM'da kalmadiysa (liste yeniden cizildi, dugme
 * kayboldu) odak `fallbackFocus` ogesine verilir.
 */
export function useModalDialog(
  open: boolean,
  onClose: () => void,
  fallbackFocus?: React.RefObject<HTMLElement | null>,
): React.RefObject<HTMLDialogElement | null> {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;

    const opener = document.activeElement as HTMLElement | null;
    const fallback = fallbackFocus?.current;
    // `close` olayi kapanistan SONRA ve asenkron ateslenir. React (StrictMode) efekti
    // kapatip hemen yeniden actiginda, onceki kapanisin gecikmis olayi yeniden acik
    // dialog'a ulasir; o durumda kapanis bildirilmez.
    const notifyClosed = (): void => {
      if (!dialog.open) onCloseRef.current();
    };
    dialog.addEventListener('close', notifyClosed);
    if (!dialog.open) dialog.showModal();

    return () => {
      dialog.removeEventListener('close', notifyClosed);
      if (dialog.open) dialog.close();
      (opener?.isConnected ? opener : fallback)?.focus();
    };
  }, [open, fallbackFocus]);

  return dialogRef;
}
