/**
 * Gorev durum makinesi.
 *
 * NEDEN AYRI BIR DOSYA VE TEST: pano uc yerden yazilir — kullanici (UI),
 * Smith (sesli arac) ve executor (worker). Uc yazarin ayni gecis kuralini
 * kendi icinde tekrar etmesi kacinilmaz olarak ayrisir; "in_progress'ten
 * dogrudan done'a atlayan" bir yol acilir ve inceleme adimi sessizce
 * kaybolur. Kural burada TEK yerde tanimlidir ve repo katmani onu zorlar.
 */

export const TASK_STATUSES = [
  'inbox',
  'assigned',
  'in_progress',
  'review',
  'done',
  'blocked',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Yalniz bu durumlar bekleyen bir AgentRun tarafindan calistirilabilir. */
export const RUNNABLE_TASK_STATUSES: readonly TaskStatus[] = ['assigned', 'in_progress'];

/**
 * Izin verilen gecisler. Kasitli kisitlar:
 *
 * - `inbox → in_progress` YOK: is ancak bir sahibi varken baslar.
 * - `in_progress → done` YOK: teslim daima `review`'dan gecer. Ajanin kendi
 *   isini "tamam" ilan etmesi, bu sistemin en pahali hatasi olurdu.
 * - `review → in_progress` ve `done → in_progress` YOK: calisma ancak bir
 *   kosuyla baslar. Revizyon (`review`) ve yeniden acma (`done`) ATAMAYLA
 *   yapilir (`→ assigned`: yeni kosu, ayni ya da baska ajan); sahipsiz geri
 *   alma `→ inbox`'tur (sahip temizlenir). Gorevi silip yeniden yaratmak
 *   gecmisi (yorumlar, kosular, maliyet) kaybettirir; bu iki yol onu korur.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  inbox: ['assigned', 'blocked'],
  assigned: ['in_progress', 'inbox', 'blocked'],
  in_progress: ['review', 'assigned', 'blocked'],
  review: ['done', 'assigned', 'inbox', 'blocked'],
  done: ['assigned', 'inbox'],
  blocked: ['inbox', 'assigned'],
};

/** /status rotasinin kabul ettigi gecisler; pano ve hata mesaji bunu kullanir. */
export const USER_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = Object.fromEntries(
  Object.entries(TASK_TRANSITIONS).map(([from, targets]) => [
    from,
    targets.filter((target) => !RUNNABLE_TASK_STATUSES.includes(target)),
  ]),
) as unknown as Record<TaskStatus, readonly TaskStatus[]>;

/** Durumun bitmis sayilip sayilmadigi — pano ve ozet sorgulari icin. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done'];

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isRunnableTaskStatus(value: string): value is TaskStatus {
  return isTaskStatus(value) && RUNNABLE_TASK_STATUSES.includes(value);
}

/**
 * Ayni duruma gecis `false` doner — bu bir hata degil, "degisiklik yok"
 * demektir; cagiran onu no-op olarak ele alir ve etkinlik akisina gurultu
 * yazmaz (bkz. repo.moveTask).
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  return TASK_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(
      `Gecersiz gorev gecisi: ${from} → ${to}. Izin verilenler: ${
        USER_TASK_TRANSITIONS[from].join(', ') || 'yok'
      }`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
