/**
 * Sandbox yasam dongusu sozlesmesi.
 *
 * TASARIM ASAMASI: henuz hicbir calisma yoluna bagli degil; izolasyon
 * saglamaz.
 *
 * Bu dosya bilincli olarak SADECE arayuz tasir. Uygulama (Docker + kayitli
 * runsc runtime'i + egress proxy'si) sonraki sprintte gelir; sozlesmenin once
 * dogru olmasi gerekiyordu cunku sonradan degistirmek her araci etkiler.
 *
 * earlier-project'dan alinan sey bu arayuzun kendisi. onceki projenin `HostFsSandboxRunner`
 * uygulamasi ALINMAZ: host'ta ciplak child_process demek, cok kiracili bir
 * sistemde izolasyon olmadan arac kosturmak demektir.
 *
 * Egress zorlamasi runner'in *icinde* degil, proxy'de yasar; runner'in gorevi
 * sandbox'in tum cikan trafigini o proxy'ye baglamak ve baska cikis
 * birakmamaktir. Politikanin kendisi ./egress.ts'te.
 */

import { type SandboxSpec } from './spec.js';
import { type SandboxRuntimeName } from './runtime.js';

export class SandboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SandboxError';
  }
}

export class SandboxTimeoutError extends SandboxError {
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = 'SandboxTimeoutError';
  }
}

/** Canli bir sandbox'a tutamak. Kapsam tasinir; sahiplik denetlenebilir olur. */
export interface SandboxHandle {
  readonly id: string;
  readonly spec: SandboxSpec;
  readonly startedAt: Date;
}

export interface ExecRequest {
  readonly argv: readonly string[];
  readonly cwd?: string;
  /** Spec'teki tavani asamaz; asarsa runner kisitlar. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Cikti kirpildiysa acikca bildirilir; sessiz kesme yok. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

/**
 * Runtime-bagimsiz arayuz. Dev makinesinde runc, uretimde runsc ile ayni
 * cagri yollarindan kosulur; secim RuntimeProfile'da tasinir, burada degil.
 */
export interface SandboxRunner {
  readonly runtime: SandboxRuntimeName;
  /**
   * Sandbox'i ayaga kaldirir. Olculen soguk baslatma maliyeti runsc'de
   * ~0.5 sn oldugu icin cagri basina degil oturum basina yapilmasi beklenir.
   */
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult>;
  destroy(handle: SandboxHandle): Promise<void>;
}
