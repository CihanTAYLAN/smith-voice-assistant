/**
 * Erisim token'i: kisa omurlu, JWT (HS256).
 *
 * Onceki hali (apps/gateway/src/auth.ts) el yapimi HMAC + base64url JSON'du;
 * yanlis degildi (timingSafeEqual dogru kullanilmisti) ama onceki projenin ayni is
 * icin `jsonwebtoken` kullanan, uretimde kanitli tercihiyle tutarli olmasi
 * icin standart JWT'ye tasindi -- iki kardes projede ayni token formatini
 * okuyup yazabilmek, ozel bir kod tabanini elde tutmaktan degerli.
 *
 * Fonksiyon adlari bilincli olarak issueSessionToken/verifySessionToken
 * DEGIL: Prisma semasinda 'Session' zaten sohbet oturumu anlamina geliyor
 * (bkz. @smith/db Session modeli); ayni kelimeyi burada da kullanmak iki
 * ayri kavrami karistirirdi.
 */

import { createWorkspaceScope, ROLES, type Role, type WorkspaceScope } from '@smith/tenancy';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const ACCESS_TOKEN_ALGORITHM = 'HS256' as const;

const payloadSchema = z.object({
  workspaceId: z.string(),
  actorId: z.string(),
  role: z.enum(ROLES),
});

export class AuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthError';
  }
}

export function issueAccessToken(
  secret: string,
  input: { workspaceId: string; actorId: string; role: Role; ttlSeconds?: number },
): string {
  return jwt.sign(
    { workspaceId: input.workspaceId, actorId: input.actorId, role: input.role },
    secret,
    {
      algorithm: ACCESS_TOKEN_ALGORITHM,
      expiresIn: input.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS,
    },
  );
}

/**
 * Token'i dogrular ve WorkspaceScope'a cevirir. Basarisizlik = istisna.
 *
 * `algorithms` acikca `[HS256]` ile sinirlanir: jwt.verify'a algoritma
 * listesi verilmezse token'in kendi header'indaki alg alani baz alinir ve
 * bu, bilinen bir JWT saldiri sinifidir (ornegin alg=none ile imza
 * atlatma). Pinlemek bu sinifi tamamen kapatir.
 */
export function verifyAccessToken(secret: string, token: string): WorkspaceScope {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, secret, { algorithms: [ACCESS_TOKEN_ALGORITHM] });
  } catch (error) {
    throw new AuthError('Erisim token gecersiz veya suresi dolmus.', { cause: error });
  }

  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AuthError('Erisim token icerigi gecersiz.');
  }

  return createWorkspaceScope(parsed.data);
}
