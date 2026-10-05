import { logFailure } from './logFailure.js';

/**
 * Bir grup Tauri dinleyicisini tek birim olarak yonetir.
 *
 * `Promise.all` ile kurulan dinleyicilerden biri reddedilirse oncekilerin
 * tutamaclari kaybolur ve dinleyici sizar; bu yardimci her tutamagi cozuldugu
 * anda toplar: kismi basarisizlikta hepsini birakir, bilesen sokulduyse gec
 * gelen tutamagi da hemen birakir. Reddedilme nedeni maskeli olarak gunluge
 * yazilir.
 */
export function createSubscriptions(): {
  /** Hepsi kurulduysa true; biri reddedildiyse ya da grup kapandiysa false. */
  connect: (requests: Array<Promise<() => void>>) => Promise<boolean>;
  close: () => void;
} {
  let closed = false;
  const handles = new Set<() => void>();
  const close = (): void => {
    closed = true;
    handles.forEach((release) => release());
    handles.clear();
  };
  return {
    close,
    async connect(requests) {
      const results = await Promise.allSettled(
        requests.map(async (request) => {
          const release = await request;
          if (closed) release();
          else handles.add(release);
        }),
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failures.length > 0) {
        failures.forEach((failure) => logFailure('events subscribe', failure.reason));
        close();
        return false;
      }
      return !closed;
    },
  };
}
