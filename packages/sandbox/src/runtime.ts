/**
 * Sandbox runtime secimi ve izolasyon sinifi.
 *
 * Tasarim karari: runtime bir konfigurasyon detayi degil, guvenlik sinifidir.
 * `runc` host cekirdegini paylasir -- bir konteyner kacisi bir kiracinin
 * ajanindan host'a, host'tan diger tum kiracilarin verisine gecer ve Postgres
 * RLS sinirinin *yanindan dolasir*. RLS veri duzlemini koruyor; bu paket
 * calistirma duzlemini korumak icin var.
 *
 * Olculen gercekler (server, 2026-08-10):
 * - server bir VMware guest'i: /dev/kvm YOK, /proc/cpuinfo'da vmx/svm YOK.
 *   Bu yuzden microVM tabanli hicbir secenek burada calismaz -- Docker
 *   Sandboxes (sbx), Kata Containers ve Firecracker hepsi KVM ister. Liste
 *   bilincli olarak 'runc' | 'runsc' ile sinirli; yeni bir isim eklemek
 *   once /dev/kvm sorusunu cevaplamayi gerektirir.
 * - gVisor runsc release-20260803.0 + --platform=systrap canli dogrulandi:
 *   sandbox icindeki cekirdek 4.19.0-gvisor, host'un 6.14'u degil. Syscall'lar
 *   userspace'teki Sentry'de sonlanir, host cekirdegine ulasmaz.
 * - Maliyet: soguk baslatma ~0.45-0.55 sn; dosya sistemi/syscall yogun iste
 *   ~10x yavaslama (10k dosya olustur/sil: 6.11 sn vs host 0.60 sn).
 *   --overlay2=root:self bu testte iyilestirme SAGLAMADI.
 *   Tasarim sonucu: bagimlilik kurulumu ve build istek basina sandbox icinde
 *   KOSULMAZ; imaja onceden gomulur, sandbox oturum boyunca sicak tutulur.
 * - Tuzak: `runsc --rootless` gVisor netstack'ini sessizce host agina dusurur
 *   ("sandbox network isn't supported with --rootless" uyarisi). Uretimde
 *   rootless kullanilmaz; Docker'a kayitli runtime olarak kosulur.
 */

import { type NodeEnvName } from '@smith/env';

/** Desteklenen OCI runtime'lari. Genisletmeden once yukaridaki KVM notunu oku. */
export const SANDBOX_RUNTIMES = ['runc', 'runsc'] as const;
export type SandboxRuntimeName = (typeof SANDBOX_RUNTIMES)[number];

/**
 * Izolasyon sinifi runtime'in *turevi*, bagimsiz bir alan degil -- boylece
 * "runc ama guvenli" gibi bir yapilandirma ifade edilemez.
 */
export type IsolationClass = 'shared-kernel' | 'sandboxed-kernel';

const ISOLATION_BY_RUNTIME: Readonly<Record<SandboxRuntimeName, IsolationClass>> = {
  runc: 'shared-kernel',
  runsc: 'sandboxed-kernel',
};

export function isolationClassOf(runtime: SandboxRuntimeName): IsolationClass {
  return ISOLATION_BY_RUNTIME[runtime];
}

/** gVisor platformu. systrap donanim sanallastirmasi istemez, kvm ister. */
export type GvisorPlatform = 'systrap' | 'kvm';

export interface RuntimeProfile {
  readonly runtime: SandboxRuntimeName;
  readonly isolation: IsolationClass;
  /** Yalnizca runsc icin anlamli. */
  readonly platform?: GvisorPlatform;
  /** Uretimde daima false olmali; bkz. netstack tuzagi. */
  readonly rootless: boolean;
}

export class RuntimeNotAllowedError extends Error {
  constructor(
    message: string,
    readonly runtime: SandboxRuntimeName,
  ) {
    super(message);
    this.name = 'RuntimeNotAllowedError';
  }
}

/**
 * Uretimde paylasilan cekirdek yasaktir. Talimat tavsiyedir, mekanizma
 * garantidir: bu cagri gateway'in sandbox olusturma yolunda durur.
 */
export function assertRuntimeAllowed(profile: RuntimeProfile, nodeEnv: NodeEnvName): void {
  if (nodeEnv !== 'production') return;

  if (profile.isolation === 'shared-kernel') {
    throw new RuntimeNotAllowedError(
      `Uretimde paylasilan cekirdek yasak: '${profile.runtime}' host cekirdegini paylasir. ` +
        `Cok kiracili arac calistirma icin 'runsc' kullan.`,
      profile.runtime,
    );
  }

  if (profile.rootless) {
    throw new RuntimeNotAllowedError(
      `Uretimde rootless runsc yasak: gVisor netstack'i devre disi kalir ve ` +
        `sandbox host agina duser, boylece egress politikasi atlanir.`,
      profile.runtime,
    );
  }
}

/** Dev makinelerinde gVisor yok; uretim varsayilani runsc. */
export function defaultRuntimeProfile(nodeEnv: NodeEnvName): RuntimeProfile {
  if (nodeEnv === 'production') {
    return {
      runtime: 'runsc',
      isolation: 'sandboxed-kernel',
      platform: 'systrap',
      rootless: false,
    };
  }
  return { runtime: 'runc', isolation: 'shared-kernel', rootless: false };
}

export function runtimeProfile(input: {
  runtime: SandboxRuntimeName;
  platform?: GvisorPlatform;
  rootless?: boolean;
}): RuntimeProfile {
  return {
    runtime: input.runtime,
    isolation: isolationClassOf(input.runtime),
    ...(input.runtime === 'runsc' ? { platform: input.platform ?? 'systrap' } : {}),
    rootless: input.rootless ?? false,
  };
}
