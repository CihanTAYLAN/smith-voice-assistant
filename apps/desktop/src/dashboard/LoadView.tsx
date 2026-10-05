import type { LoadState } from './loadable.js';

const formatClock = (at: number): string =>
  new Date(at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

/**
 * Hata/bayat durum cumlesi; `ready` ve `loading` icin null. `subject` ("Vault")
 * birden cok kaynakli ekranlarda hangi verinin etkilendigini soyler.
 */
export function faultText<T>(state: LoadState<T>, subject?: string): string | null {
  if (state.status === 'error') return `${subject ?? 'Veri'} okunamadı. ${state.error}`;
  if (state.status === 'stale') {
    return `${subject ?? 'Veri'} bayat (son okuma ${formatClock(state.at)}). ${state.error}`;
  }
  return null;
}

export function Fault({
  message,
  onRetry,
  retryLabel = 'Yeniden dene',
}: {
  message: string;
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
}): React.JSX.Element {
  return (
    <p role="alert" className="db-banner db-banner-fault">
      {message}
      {onRetry ? (
        <button type="button" className="db-link" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </p>
  );
}

export function Loading({ text = 'Yükleniyor…' }: { text?: string }): React.JSX.Element {
  return (
    <div className="db-state" role="status" aria-live="polite">
      {text}
      <div className="db-loading-bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="db-state">
      <div className="db-state-title">{title}</div>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

interface LoadViewProps<T> {
  state: LoadState<T>;
  /** Hazir (veya bayat) veriyi cizer; "bos" gosterimi de buradadir. */
  children: (data: T) => React.ReactNode;
  loadingText?: string;
  onRetry?: () => void;
}

/**
 * Bir `LoadState`i tek bicimde sunar: yukleniyor | hata | bayat (eski veri +
 * uyari) | hazir. Ilk yukleme asla "bos" gibi gorunmez.
 */
export function LoadView<T>({
  state,
  children,
  loadingText = 'Yükleniyor…',
  onRetry,
}: LoadViewProps<T>): React.JSX.Element {
  const fault = faultText(state);
  return (
    <>
      {fault ? <Fault message={fault} onRetry={onRetry} /> : null}
      {state.status === 'loading' ? <Loading text={loadingText} /> : null}
      {state.status === 'ready' || state.status === 'stale' ? children(state.data) : null}
    </>
  );
}
