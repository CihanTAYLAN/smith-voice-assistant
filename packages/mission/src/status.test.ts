import { describe, expect, it } from 'vitest';

import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTaskStatus,
  TASK_STATUSES,
  TASK_TRANSITIONS,
} from './status.js';

describe('gorev durum makinesi', () => {
  it('normal akisi bastan sona gecirir', () => {
    expect(canTransition('inbox', 'assigned')).toBe(true);
    expect(canTransition('assigned', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'review')).toBe(true);
    expect(canTransition('review', 'done')).toBe(true);
  });

  it('inceleme adimini atlamaya izin vermez', () => {
    // Bu testin varlik sebebi: ajanin kendi isini "tamam" ilan etmesi bu
    // sistemin en pahali hatasi olurdu. Kural kod icinde tekrarlanmasin diye
    // burada kilitlenir.
    expect(canTransition('in_progress', 'done')).toBe(false);
    expect(canTransition('assigned', 'done')).toBe(false);
    expect(canTransition('inbox', 'done')).toBe(false);
  });

  it('sahipsiz gorevin baslamasina izin vermez', () => {
    expect(canTransition('inbox', 'in_progress')).toBe(false);
  });

  it('revizyon ve yeniden acma atamayla yapilir: review ve done assigned a gecebilir', () => {
    // Geri alma yolu, kosu yaratan tek yoldur (assignTask). Kosusuz bir gorevi
    // elle in_progress yapmak panoda "calisiyor" yalani uretirdi.
    expect(canTransition('review', 'assigned')).toBe(true);
    expect(canTransition('done', 'assigned')).toBe(true);
    expect(canTransition('review', 'in_progress')).toBe(false);
    expect(canTransition('done', 'in_progress')).toBe(false);
  });

  it('sahipsiz geri alma: review ve done inbox a donebilir', () => {
    expect(canTransition('review', 'inbox')).toBe(true);
    expect(canTransition('done', 'inbox')).toBe(true);
  });

  it('done tek basina bitmis degildir ama baska yone de acilmaz', () => {
    expect(canTransition('done', 'review')).toBe(false);
    expect(canTransition('done', 'blocked')).toBe(false);
  });

  it('atanmis gorev blocked durumuna gecebilir ama oradan calismaz', () => {
    expect(canTransition('assigned', 'blocked')).toBe(true);
    expect(canTransition('blocked', 'in_progress')).toBe(false);
    expect(() => assertTransition('blocked', 'in_progress')).toThrow(InvalidTransitionError);
  });

  it('ayni duruma gecis degisiklik saymaz ama hata da atmaz', () => {
    expect(canTransition('review', 'review')).toBe(false);
    expect(() => assertTransition('review', 'review')).not.toThrow();
  });

  it('gecersiz gecis izin verilenleri listeleyerek patlar', () => {
    const error = (() => {
      try {
        assertTransition('in_progress', 'done');
      } catch (caught) {
        return caught;
      }
      throw new Error('gecis beklenmedik bicimde gecti');
    })();
    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect((error as Error).message).toContain('review');
    expect((error as Error).message).toContain('blocked');
    expect((error as Error).message).not.toMatch(/Izin verilenler:.*assigned/);
    expect((error as Error).message).not.toMatch(/Izin verilenler:.*in_progress/);
  });

  it('bilinmeyen durum kabul edilmez', () => {
    expect(isTaskStatus('inbox')).toBe(true);
    expect(isTaskStatus('DONE')).toBe(false);
    expect(isTaskStatus('archived')).toBe(false);
  });

  it('gecis tablosu yalniz tanimli durumlara isaret eder', () => {
    // Tablonun kendisi de veri; yazim hatasi (or. 'in-progress') bu testte
    // yakalanir, uretimde 'gecersiz gecis' seklinde degil.
    for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
      expect(TASK_STATUSES).toContain(from);
      for (const to of targets) expect(TASK_STATUSES).toContain(to);
    }
  });
});
