import { describe, expect, it } from 'vitest';

import { ancestorDirs } from './treePaths.js';

const windows = [
  { label: 'ObsidianVaults', path: 'C:\\Users\\cihan\\ObsidianVaults' },
  { label: 'home', path: 'C:\\Users\\cihan' },
];
const posix = [{ label: 'vault', path: '/home/cihan/vault/' }];

describe('ancestorDirs', () => {
  it('Windows yolunda kokten dosyanin klasorune kadar her dizini verir', () => {
    expect(
      ancestorDirs(windows, 'C:\\Users\\cihan\\ObsidianVaults\\personal\\notes\\a.md'),
    ).toEqual([
      'C:\\Users\\cihan\\ObsidianVaults',
      'C:\\Users\\cihan\\ObsidianVaults\\personal',
      'C:\\Users\\cihan\\ObsidianVaults\\personal\\notes',
    ]);
  });

  it('POSIX yolunda ayiraci korur ve kokun sondaki ayiracini yutar', () => {
    expect(ancestorDirs(posix, '/home/cihan/vault/p/a.md')).toEqual([
      '/home/cihan/vault/',
      '/home/cihan/vault/p',
    ]);
  });

  it('kokun hemen altindaki dosya yalniz koku acar', () => {
    expect(ancestorDirs(windows, 'C:\\Users\\cihan\\ObsidianVaults\\a.md')).toEqual([
      'C:\\Users\\cihan\\ObsidianVaults',
    ]);
  });

  it('ic ice kokte ilk eslesen kok kazanir', () => {
    expect(ancestorDirs(windows, 'C:\\Users\\cihan\\Desktop\\a.md')).toEqual([
      'C:\\Users\\cihan',
      'C:\\Users\\cihan\\Desktop',
    ]);
  });

  it('hicbir kokun altinda olmayan veya benzer onekli yolu acmaz', () => {
    expect(ancestorDirs(windows, 'D:\\other\\a.md')).toEqual([]);
    expect(ancestorDirs(windows, 'C:\\Users\\cihanX\\a.md')).toEqual([]);
  });
});
