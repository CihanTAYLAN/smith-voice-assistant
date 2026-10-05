import type { Offset } from '@cruxgarden/plasma-ui';

/** Kontrol bolumunun kart kimlikleri; yerlesim kaydinin (`localStorage`) anahtarlari. */
export type CardId = 'engines' | 'usage' | 'pending';

export interface CardSpec {
  /** Varsayilan konum; grid (24 px) katlaridir ki ilk gorunum de hizali olsun. */
  x: number;
  y: number;
  width: number;
}

export const CARDS: Record<CardId, CardSpec> = {
  engines: { x: 0, y: 0, width: 480 },
  usage: { x: 504, y: 0, width: 560 },
  pending: { x: 0, y: 336, width: 480 },
};

export const CARD_IDS = Object.keys(CARDS) as CardId[];

export interface FieldSize {
  width: number;
  height: number;
}

const RIGHT_MARGIN = 8;
/** Serbest yerlesimde bir kartin en az bu kadar yuksekligi gorunur kalir. */
export const MIN_VISIBLE_HEIGHT = 160;
/** Varsayilan yerlesimin ust uste binmeden sigdigi en kucuk alan yuksekligi. */
const FREE_MIN_HEIGHT = 680;

/** Varsayilan iki kolonlu yerlesimin sigdigi en kucuk alan genisligi. */
export const FREE_MIN_WIDTH =
  Math.max(...CARD_IDS.map((id) => CARDS[id].x + CARDS[id].width)) + RIGHT_MARGIN;

/**
 * Alan varsayilan yerlesimi tasiyorsa kartlar serbestce suruklenir; degilse
 * (dar pencere) tek akiskan izgaraya gecilir ve hicbir kart kesilmez.
 */
export function isFreeLayout(field: FieldSize): boolean {
  return field.width >= FREE_MIN_WIDTH && field.height >= FREE_MIN_HEIGHT;
}

export function defaultOffsets(saved: Record<string, Offset> = {}): Record<CardId, Offset> {
  const offsets = {} as Record<CardId, Offset>;
  for (const id of CARD_IDS) offsets[id] = saved[id] ?? { x: CARDS[id].x, y: CARDS[id].y };
  return offsets;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max));

/**
 * Kayitli konumu alanin icinde tutar (pencere kuculse de kart disarida
 * kalmaz): yatayda kart tam sigar, dikeyde en az `MIN_VISIBLE_HEIGHT` gorunur.
 */
export function clampOffset(id: CardId, offset: Offset, field: FieldSize): Offset {
  return {
    x: clamp(offset.x, 0, field.width - CARDS[id].width),
    y: clamp(offset.y, 0, field.height - MIN_VISIBLE_HEIGHT),
  };
}
