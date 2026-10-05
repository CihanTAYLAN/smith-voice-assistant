import type { WorkspaceScope } from '@smith/tenancy';

import { newDevicePairingId, newRefreshTokenId } from '../ids.js';
import type { Tx } from '../scoped.js';

/**
 * Credential, RefreshToken, DevicePairing global kimlik verisidir (Actor
 * gibi) ve RLS'e tabi degildir -- bkz. schema.prisma yorumu. Buradaki
 * fonksiyonlar bilincli olarak WorkspaceScope degil (gerektiginde) SystemScope
 * kabul eder: giris/kayit/eslestirme henuz dogrulanmis bir workspace kapsami
 * yokken calisir.
 */

export interface CredentialRecord {
  actorId: string;
  passwordHash: string;
}

export async function findCredentialByActorId(
  tx: Tx,
  actorId: string,
): Promise<CredentialRecord | null> {
  return tx.credential.findUnique({
    where: { actorId },
    select: { actorId: true, passwordHash: true },
  });
}

/** Ilk kayit ve sifre degisimi ayni islemdir. */
export async function upsertCredential(
  tx: Tx,
  actorId: string,
  passwordHash: string,
): Promise<void> {
  await tx.credential.upsert({
    where: { actorId },
    create: { actorId, passwordHash },
    update: { passwordHash },
  });
}

export interface RefreshTokenRecord {
  id: string;
  actorId: string;
  workspaceId: string;
  tokenHash: string;
  family: string;
  deviceLabel: string;
  surface: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface CreateRefreshTokenInput {
  actorId: string;
  workspaceId: string;
  tokenHash: string;
  family: string;
  deviceLabel: string;
  surface: string;
  expiresAt: Date;
}

export async function createRefreshToken(
  tx: Tx,
  input: CreateRefreshTokenInput,
): Promise<RefreshTokenRecord> {
  return tx.refreshToken.create({ data: { id: newRefreshTokenId(), ...input } });
}

/** Yalniz AKTIF (iptal edilmemis, suresi gecmemis) token'i dondurur. */
export async function findActiveRefreshTokenByHash(
  tx: Tx,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  return tx.refreshToken.findFirst({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
  });
}

/**
 * Hash'i iptal durumundan BAGIMSIZ arar. Rotasyon sonrasi iptal edilmis bir
 * token'in yeniden sunulmasi calinti sinyalidir; cagiran taraf bu fonksiyonla
 * "bu hash hic var oldu mu, iptal mi edilmis" ayrimini yapar.
 */
export async function findRefreshTokenByHash(
  tx: Tx,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  return tx.refreshToken.findUnique({ where: { tokenHash } });
}

export async function revokeRefreshToken(tx: Tx, id: string): Promise<void> {
  await tx.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } });
}

/** Calinti sinyali sonrasi: ayni soydaki (family) TUM aktif token'lar iptal edilir. */
export async function revokeRefreshTokenFamily(tx: Tx, family: string): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { family, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export type PairingStatus = 'pending' | 'approved' | 'consumed' | 'denied' | 'expired';

export interface DevicePairingRecord {
  id: string;
  codeHash: string;
  surface: string;
  /** @smith/tenancy'nin Role'u gibi: DB katmaninda dogrulanmaz, cagiran taraf PairingStatus'e karsi dogrular. */
  status: string;
  expiresAt: Date;
  approvedActorId: string | null;
  approvedWorkspaceId: string | null;
  approvedRole: string | null;
}

export interface CreateDevicePairingInput {
  codeHash: string;
  surface: string;
  expiresAt: Date;
}

export async function createDevicePairing(
  tx: Tx,
  input: CreateDevicePairingInput,
): Promise<DevicePairingRecord> {
  return tx.devicePairing.create({
    data: { id: newDevicePairingId(), status: 'pending', ...input },
  });
}

export async function findPendingDevicePairingByCodeHash(
  tx: Tx,
  codeHash: string,
): Promise<DevicePairingRecord | null> {
  return tx.devicePairing.findFirst({
    where: { codeHash, status: 'pending', expiresAt: { gt: new Date() } },
  });
}

/** Durumdan bagimsiz arama: exchange endpoint'i "henuz onaylanmadi" ile "hic yok" u ayirt etmek icin kullanir. */
export async function findDevicePairingByCodeHash(
  tx: Tx,
  codeHash: string,
): Promise<DevicePairingRecord | null> {
  return tx.devicePairing.findUnique({ where: { codeHash } });
}

/**
 * Onay: onaylayan tarafin ZATEN dogrulanmis WorkspaceScope'undan kopyalanir.
 *
 * WHERE'e status:'pending' konmasi sadece bir on-kontrol degil, yaris
 * durumuna karsi asil savunmadir: Postgres bir UPDATE'in WHERE'ini satir
 * kilidi alindiktan sonra en son commit edilmis haline gore yeniden
 * degerlendirir (READ COMMITTED altinda bile). Iki eszamanli onay denemesi
 * gelirse ikincisi WHERE'i artik 'pending' olmayan satira karsi test eder ve
 * count=0 doner -- ekstra bir kilit veya SERIALIZABLE gerekmez.
 */
export async function approveDevicePairing(
  tx: Tx,
  id: string,
  approvedBy: WorkspaceScope,
): Promise<DevicePairingRecord | null> {
  const result = await tx.devicePairing.updateMany({
    where: { id, status: 'pending' },
    data: {
      status: 'approved',
      approvedActorId: approvedBy.actorId,
      approvedWorkspaceId: approvedBy.workspaceId,
      approvedRole: approvedBy.role,
    },
  });
  if (result.count === 0) return null;
  return tx.devicePairing.findUnique({ where: { id } });
}

/**
 * Tek kullanimlik teslim. Ayni atomik-WHERE deseni: sadece 'approved'
 * durumundaki bir kayit tuketilebilir, ayni kodun iki kez tuketilmesi
 * count=0 ile engellenir.
 */
export async function consumeDevicePairing(
  tx: Tx,
  codeHash: string,
): Promise<DevicePairingRecord | null> {
  const existing = await tx.devicePairing.findUnique({ where: { codeHash } });
  if (!existing || existing.status !== 'approved') return null;

  const result = await tx.devicePairing.updateMany({
    where: { codeHash, status: 'approved' },
    data: { status: 'consumed' },
  });
  return result.count === 0 ? null : existing;
}
