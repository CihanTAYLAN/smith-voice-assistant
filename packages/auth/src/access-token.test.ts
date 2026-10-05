import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { AuthError, issueAccessToken, verifyAccessToken } from './index.js';

const SECRET = 'test-secret-en-az-otuz-iki-karakter-uzunlugunda';
const INPUT = {
  workspaceId: 'ws_abcdefghij0123456789',
  actorId: 'act_abcdefghij0123456789',
  role: 'member' as const,
};

describe('erisim token', () => {
  it('uretilip dogrulanan token WorkspaceScope a cevrilir', () => {
    const token = issueAccessToken(SECRET, INPUT);
    const scope = verifyAccessToken(SECRET, token);
    expect(scope).toMatchObject(INPUT);
  });

  it('yanlis sirla dogrulanamaz', () => {
    const token = issueAccessToken(SECRET, INPUT);
    expect(() => verifyAccessToken('baska-bir-sir-en-az-otuz-iki-karakter', token)).toThrow(
      AuthError,
    );
  });

  it('suresi dolmus token reddedilir', () => {
    const token = issueAccessToken(SECRET, { ...INPUT, ttlSeconds: -1 });
    expect(() => verifyAccessToken(SECRET, token)).toThrow(AuthError);
  });

  it('bozuk token bicimi reddedilir', () => {
    expect(() => verifyAccessToken(SECRET, 'bicimsiz.token')).toThrow(AuthError);
  });

  /** algorithms sabitlemesi yoksa alg=none gibi saldirilar imza dogrulamasini atlatabilir. */
  it("alg='none' ile uretilmis token reddedilir", () => {
    const forged = jwt.sign(INPUT, undefined as unknown as string, { algorithm: 'none' });
    expect(() => verifyAccessToken(SECRET, forged)).toThrow(AuthError);
  });

  it('gecerli imza ama beklenmeyen govde (role eksik) reddedilir', () => {
    const malformed = jwt.sign({ workspaceId: INPUT.workspaceId, actorId: INPUT.actorId }, SECRET, {
      algorithm: 'HS256',
      expiresIn: 900,
    });
    expect(() => verifyAccessToken(SECRET, malformed)).toThrow(AuthError);
  });

  it('gecersiz role degeri reddedilir', () => {
    const malformed = jwt.sign({ ...INPUT, role: 'superadmin' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: 900,
    });
    expect(() => verifyAccessToken(SECRET, malformed)).toThrow(AuthError);
  });
});
