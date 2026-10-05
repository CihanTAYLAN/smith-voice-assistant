/**
 * Sandbox'a kimlik bilgisi tasima sozlesmesi.
 *
 * Tasarim karari: sandbox bir sirri asla *deger* olarak gormez. Spec'te
 * tasinan sey bir referanstir; gercek deger yalnizca egress proxy'sinde,
 * yalnizca hedef host'a giden istege enjekte edilir. Boylece:
 *
 * - Sirlar sandbox dosya sistemine ve env'ine hic inmez; ajan `env` yazdirsa
 *   ya da dosyalari sizdirsa ortaya cikacak bir deger yoktur.
 * - Her sir tek bir hedefe baglidir. GitHub token'i yalnizca GitHub'a giden
 *   istege eklenir; ajan onu baska bir yere gonderemez cunku degeri yok.
 *
 * Bunu sonradan eklemek her aracin tesisatini yeniden cekmek demek; bu yuzden
 * gun bir burada.
 */

import { type EgressPolicy, evaluateEgress } from './egress.js';

declare const brand: unique symbol;

/** Sir deposundaki mantiksal ad. Duz string atanamaz. */
export type SecretName = string & { readonly [brand]: 'SecretName' };

export const SECRET_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

export class SecretRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretRefError';
  }
}

export function toSecretName(raw: string): SecretName {
  if (!SECRET_NAME_PATTERN.test(raw)) {
    throw new SecretRefError(`Gecersiz sir adi: ${JSON.stringify(raw)}`);
  }
  return raw as SecretName;
}

/** Proxy'nin sirri istege nasil ekleyecegi. Sandbox icine yazma secenegi YOK. */
export type InjectionSite = 'authorization-bearer' | 'header' | 'basic-auth';

export interface SecretRef {
  readonly name: SecretName;
  readonly injectAt: InjectionSite;
  /** injectAt === 'header' oldugunda zorunlu. */
  readonly header?: string;
  /** Sirrin gecerli oldugu tek host. Joker kabul edilmez. */
  readonly forHost: string;
}

const HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function secretRef(input: {
  name: string;
  injectAt: InjectionSite;
  header?: string;
  forHost: string;
}): SecretRef {
  const forHost = input.forHost.trim().toLowerCase();

  if (forHost.length === 0) {
    throw new SecretRefError('Sir referansi bir hedef host tasimak zorunda.');
  }
  if (forHost.includes('*')) {
    throw new SecretRefError(
      `Sir referansinda joker yasak: ${JSON.stringify(input.forHost)}. ` +
        `Her sir tek bir hedefe baglanir.`,
    );
  }
  if (input.injectAt === 'header') {
    if (input.header === undefined || !HEADER_NAME_PATTERN.test(input.header)) {
      throw new SecretRefError(
        `injectAt='header' icin gecerli bir header adi zorunlu: ${JSON.stringify(input.header)}`,
      );
    }
  } else if (input.header !== undefined) {
    throw new SecretRefError(`injectAt='${input.injectAt}' header adi almaz.`);
  }

  return {
    name: toSecretName(input.name),
    injectAt: input.injectAt,
    ...(input.header === undefined ? {} : { header: input.header }),
    forHost,
  };
}

/**
 * Sirlar ile egress politikasi arasindaki capraz kontrol.
 *
 * Neden: egress'in izin vermedigi bir host icin sir tanimlamak en iyi halde
 * olu yapilandirma, en kotu halde yanlis guven. Tersi de gecerli -- politika
 * daraltilirsa buna bagli sirlar da gorunur olmali.
 */
export function assertSecretsCoveredByEgress(
  secrets: readonly SecretRef[],
  policy: EgressPolicy,
): void {
  for (const ref of secrets) {
    const verdict = evaluateEgress(policy, { host: ref.forHost });
    if (!verdict.allowed) {
      throw new SecretRefError(
        `'${ref.name}' sirri egress'in izin vermedigi bir host'a bagli ` +
          `(${ref.forHost}): ${verdict.reason}`,
      );
    }
  }
}

/**
 * Log ve hata ciktilari icin guvenli tanim. Enjekte edilecek deger bu surecte
 * hic bulunmadigi icin maskelenecek bir sey de yok -- tasarimin amaci bu.
 */
export function describeSecretRef(ref: SecretRef): string {
  const where = ref.injectAt === 'header' ? `header:${ref.header ?? '?'}` : ref.injectAt;
  return `${ref.name} -> ${ref.forHost} (${where})`;
}

/**
 * Sandbox env'ine sir sizmasina karsi determinist kapi.
 *
 * Desen @smith/env'deki maskeleme kuralinin ayni disiplinidir; orada deger
 * *log'da* saklanir, burada sandbox'a *hic girmez*. Ikinci gercek kullanim
 * oldugunda ortak bir yere tasinabilir.
 */
const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|KEY|DSN|CREDENTIAL)$/i;

export function assertNoSecretsInEnv(env: Readonly<Record<string, string>>): void {
  const offenders = Object.keys(env).filter((key) => SECRET_KEY_PATTERN.test(key));
  if (offenders.length > 0) {
    throw new SecretRefError(
      `Sandbox env'ine sir konulamaz: ${offenders.join(', ')}. ` +
        `Bunun yerine secretRef() ile proxy enjeksiyonu kullan.`,
    );
  }
}
