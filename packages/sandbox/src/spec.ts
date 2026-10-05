/**
 * Sandbox spec'i: bir aracin hangi kosullarda kosacaginin tam tanimi.
 *
 * Tasarim karari: spec'i uretmek TEK bogaz noktasidir. createSandboxSpec
 * cagrilmadan sandbox olusturulamaz ve bu fonksiyon runtime, egress ve sir
 * kontrollerinin hepsini kosar. Boylece "egress politikasini vermeyi unutmak"
 * mumkun degil -- alan zorunlu, varsayilani yok.
 *
 * Kapsam tipi bilincli olarak WorkspaceScope: bir sandbox daima bir kiraciya
 * aittir. SystemScope ile spec uretmek derleme hatasidir, cunku "kiracisiz
 * arac calistirma" cok kiracili bir sistemde anlamsizdir.
 */

import { type NodeEnvName } from '@smith/env';
import { type WorkspaceScope } from '@smith/tenancy';

import {
  assertNoSecretsInEnv,
  assertSecretsCoveredByEgress,
  type SecretRef,
} from './credentials.js';
import { type EgressPolicy } from './egress.js';
import { assertRuntimeAllowed, type RuntimeProfile } from './runtime.js';

export class SandboxSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxSpecError';
  }
}

/**
 * Kaynak tavanlari. Hepsi zorunlu: sinirsiz kaynak cok kiracili bir sistemde
 * bir kiracinin digerlerini acdirmasi demek.
 */
export interface ResourceLimits {
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly pids: number;
  /** Duvar saati tavani; sonsuza kadar kosan arac yok. */
  readonly timeoutMs: number;
}

/**
 * Olculen ~10x dosya sistemi cezasi yuzunden zaman asimi cikplak host
 * sezgisinden cok daha genis tutulmali; buna karsilik bagimlilik kurulumu
 * hic burada kosmamali.
 */
export const DEFAULT_LIMITS: ResourceLimits = {
  cpus: 2,
  memoryMiB: 2048,
  pids: 512,
  timeoutMs: 120_000,
};

export interface WorkspaceMount {
  /** Sandbox icindeki yol. Kiracinin calisma alani yalnizca buraya baglanir. */
  readonly containerPath: string;
  readonly readOnly: boolean;
}

export interface SandboxSpec {
  readonly scope: WorkspaceScope;
  readonly runtime: RuntimeProfile;
  readonly image: string;
  readonly command: readonly string[];
  /** Zorunlu alan; varsayilani yok. Kapali baslamak bilincli bir karardir. */
  readonly egress: EgressPolicy;
  readonly secrets: readonly SecretRef[];
  readonly env: Readonly<Record<string, string>>;
  readonly workspace: WorkspaceMount;
  readonly limits: ResourceLimits;
  /** Kok dosya sistemi salt-okunur; yazma yalnizca calisma alanina. */
  readonly readOnlyRootFs: boolean;
}

/** `ad:etiket` veya digest'li tam referans; etiketsiz imaj kabul edilmez. */
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(:[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/;

export interface SandboxSpecInput {
  readonly scope: WorkspaceScope;
  readonly runtime: RuntimeProfile;
  readonly image: string;
  readonly command: readonly string[];
  readonly egress: EgressPolicy;
  readonly secrets?: readonly SecretRef[];
  readonly env?: Readonly<Record<string, string>>;
  readonly workspace?: WorkspaceMount;
  readonly limits?: Partial<ResourceLimits>;
}

/**
 * Tum davetsiz durumlar burada elenir. Bir spec elde ettiysen; runtime
 * uretime uygun, egress politikasi acikca verilmis, sirlar egress kapsaminda
 * ve env temiz demektir.
 */
export function createSandboxSpec(input: SandboxSpecInput, nodeEnv: NodeEnvName): SandboxSpec {
  assertRuntimeAllowed(input.runtime, nodeEnv);

  if (!IMAGE_PATTERN.test(input.image)) {
    throw new SandboxSpecError(
      `Imaj referansi etiket veya digest tasimak zorunda: ${JSON.stringify(input.image)}`,
    );
  }
  if (input.command.length === 0) {
    throw new SandboxSpecError('Bos komut ile sandbox olusturulamaz.');
  }

  const env = input.env ?? {};
  assertNoSecretsInEnv(env);

  const secrets = input.secrets ?? [];
  assertSecretsCoveredByEgress(secrets, input.egress);

  const limits: ResourceLimits = { ...DEFAULT_LIMITS, ...input.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new SandboxSpecError(`Kaynak tavani pozitif olmali: ${key}=${String(value)}`);
    }
  }

  const workspace = input.workspace ?? { containerPath: '/workspace', readOnly: false };
  if (!workspace.containerPath.startsWith('/')) {
    throw new SandboxSpecError(
      `Calisma alani yolu mutlak olmali: ${JSON.stringify(workspace.containerPath)}`,
    );
  }

  return {
    scope: input.scope,
    runtime: input.runtime,
    image: input.image,
    command: [...input.command],
    egress: input.egress,
    secrets: [...secrets],
    env: { ...env },
    workspace,
    limits,
    readOnlyRootFs: true,
  };
}
