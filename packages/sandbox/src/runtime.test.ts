import { describe, expect, it } from 'vitest';

import {
  assertRuntimeAllowed,
  defaultRuntimeProfile,
  isolationClassOf,
  RuntimeNotAllowedError,
  runtimeProfile,
  SANDBOX_RUNTIMES,
} from './index.js';

describe('runtime izolasyon sinifi', () => {
  it('runc paylasilan cekirdek, runsc ayri cekirdek', () => {
    expect(isolationClassOf('runc')).toBe('shared-kernel');
    expect(isolationClassOf('runsc')).toBe('sandboxed-kernel');
  });

  /**
   * server'te /dev/kvm yok; microVM tabanli runtime'lar (Kata, Firecracker,
   * Docker Sandboxes) bu yuzden listede degil. Liste buyuyorsa once o soru
   * cevaplanmali.
   */
  it('desteklenen runtime listesi bilincli olarak dar', () => {
    expect([...SANDBOX_RUNTIMES]).toEqual(['runc', 'runsc']);
  });

  it('runsc profili varsayilan olarak systrap ve rootless degil', () => {
    const profile = runtimeProfile({ runtime: 'runsc' });
    expect(profile.platform).toBe('systrap');
    expect(profile.rootless).toBe(false);
  });
});

describe('uretim kapisi', () => {
  it('uretimde paylasilan cekirdek reddedilir', () => {
    expect(() => assertRuntimeAllowed(runtimeProfile({ runtime: 'runc' }), 'production')).toThrow(
      RuntimeNotAllowedError,
    );
  });

  it('dev ortaminda runc kabul edilir', () => {
    expect(() =>
      assertRuntimeAllowed(runtimeProfile({ runtime: 'runc' }), 'development'),
    ).not.toThrow();
  });

  /** rootless runsc gVisor netstack'ini host agina dusurur; egress atlanir. */
  it('uretimde rootless runsc reddedilir', () => {
    expect(() =>
      assertRuntimeAllowed(runtimeProfile({ runtime: 'runsc', rootless: true }), 'production'),
    ).toThrow(RuntimeNotAllowedError);
  });

  it('uretimde rootless olmayan runsc kabul edilir', () => {
    expect(() =>
      assertRuntimeAllowed(runtimeProfile({ runtime: 'runsc' }), 'production'),
    ).not.toThrow();
  });

  it('varsayilan profil ortama gore secilir', () => {
    expect(defaultRuntimeProfile('production').runtime).toBe('runsc');
    expect(defaultRuntimeProfile('development').runtime).toBe('runc');
  });
});
