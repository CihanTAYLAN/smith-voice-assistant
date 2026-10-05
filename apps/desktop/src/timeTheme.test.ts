import { describe, expect, it } from 'vitest';

import { currentTimeTheme, resolveTimeTheme } from './timeTheme.js';

describe('resolveTimeTheme — saat siniri', () => {
  const cases: Array<[number, string]> = [
    [0, 'night'],
    [5, 'night'],
    [6, 'morning'],
    [10, 'morning'],
    [11, 'day'],
    [16, 'day'],
    [17, 'sunset'],
    [20, 'sunset'],
    [21, 'night'],
    [23, 'night'],
  ];

  it.each(cases)('saat %i -> %s', (hour, expected) => {
    expect(resolveTimeTheme(hour)).toBe(expected);
  });
});

describe('currentTimeTheme', () => {
  it('verilen Date nesnesinin saatini kullanir', () => {
    expect(currentTimeTheme(new Date(2026, 0, 1, 8, 0, 0))).toBe('morning');
    expect(currentTimeTheme(new Date(2026, 0, 1, 22, 0, 0))).toBe('night');
  });
});
