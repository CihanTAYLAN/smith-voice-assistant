import { verifyAccessToken } from '@smith/auth';
import { createWorkspaceScope, InvalidScopeError, toWorkspaceId } from '@smith/tenancy';
import type { WorkspaceScope } from '@smith/tenancy';

import { asRole } from './routes/auth.js';

/**
 * `Authorization: Bearer <access token>` → WorkspaceScope.
 *
 * Iki HTTP arac yuzeyi (hafiza araclari ve Mission Control) ayni cozumlemeyi
 * yapiyor; ikinci gercek kullanimda ortaklastirildi. Kapsam cikarmanin tek
 * yerde olmasi guvenlik acisindan da onemli: bir yerde rol donusumu atlanirsa
 * o uc sessizce daha yetkili davranir.
 *
 * Token gecersiz/eksikse `null` doner — cagiran 401 verir. Hata detayini
 * disariya sizdirmayiz.
 */
export function scopeFromAuthHeader(
  sessionSecret: string,
  authHeader: string | undefined,
): WorkspaceScope | null {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const claims = verifyAccessToken(sessionSecret, token);
    return createWorkspaceScope({
      workspaceId: toWorkspaceId(claims.workspaceId),
      actorId: claims.actorId,
      role: asRole(claims.role),
    });
  } catch (error) {
    if (error instanceof InvalidScopeError) return null;
    return null;
  }
}
