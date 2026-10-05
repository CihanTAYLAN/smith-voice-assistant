import {
  AuthError,
  BCRYPT_MAX_PASSWORD_BYTES,
  burnPasswordCost,
  generatePairingCode,
  generateRefreshToken,
  hashPairingCandidate,
  hashPassword,
  hashRefreshTokenCandidate,
  issueAccessToken,
  PAIRING_CODE_TTL_SECONDS,
  passwordFitsBcryptLimit,
  REFRESH_TOKEN_TTL_SECONDS,
  verifyAccessToken,
  verifyPassword,
} from '@smith/auth';
import {
  approveDevicePairing,
  consumeDevicePairing,
  createDevicePairing,
  createRefreshToken,
  findActiveRefreshTokenByHash,
  findActorByEmail,
  findCredentialByActorId,
  findDevicePairingByCodeHash,
  findMembership,
  findPendingDevicePairingByCodeHash,
  findRefreshTokenByHash,
  newActorId,
  newWorkspaceId,
  revokeRefreshToken,
  revokeRefreshTokenFamily,
  upsertCredential,
  withScope,
  type DbHandle,
} from '@smith/db';
import { clientSurfaceSchema } from '@smith/protocol';
import {
  createSystemScope,
  createWorkspaceScope,
  InvalidScopeError,
  RLS_SESSION_VARIABLE,
  ROLES,
  toWorkspaceId,
  type Role,
  type WorkspaceScope,
} from '@smith/tenancy';
import { Hono } from 'hono';
import { z } from 'zod';

import { resolveRemoteAddress } from '../network.js';
import {
  createAttemptLimiter,
  limitByIp,
  LOGIN_POLICY,
  PAIRING_EXCHANGE_POLICY,
  PAIRING_START_POLICY,
  REGISTER_POLICY,
  tooManyRequests,
  type AttemptPolicy,
} from './attempt-limiter.js';
import { createRefreshReplayCache } from './auth-refresh-replay.js';

/**
 * Gercek uretim auth uc noktalari. apps/gateway/src/auth.ts'in yerini alir --
 * o dosya artik yok, token uretimi/dogrulamasi @smith/auth'tan geliyor.
 *
 * Iki farkli "kapsamsiz" durum var, karistirilmamali:
 * - Giris/kayit/eslestirme okumalari: henuz dogrulanmis KIMSE yok,
 *   SystemScope + acik gerekce (RLS'siz tablolarda islevsel fark yaratmaz,
 *   ama "neden scope yok" sorusuna audit-okunabilir bir cevap birakir).
 * - Kayit sirasinda Membership YAZIMI: RLS WITH CHECK gerektirir. Yeni
 *   workspace/actor icin bir WorkspaceScope PESIN kurulur (henuz DB'de
 *   karsiligi yok) ve transaction o scope altinda satirlari yazar.
 *
 * Bellek ici iki yardimci tek surece baglidir (gateway tek surectir): deneme hiz
 * siniri (`attempt-limiter.ts`: giris, kayit, eslestirme) ve refresh rotasyonu
 * toleransi (`auth-refresh-replay.ts`).
 */

function badRole(role: string): never {
  throw new Error(`Beklenmeyen rol degeri veritabaninda: ${JSON.stringify(role)}`);
}

/**
 * Membership.role veritabaninda duz string'tir; sinir gecisinde dogrulanir.
 * index.ts'teki dev-login da bunu kullanir (ikinci gercek kullanim).
 */
export function asRole(role: string): Role {
  return ROLES.find((r) => r === role) ?? badRole(role);
}

/** `Authorization: Bearer <token>` okur ve dogrular. Basarisizlik = AuthError. */
function requireAccessToken(
  authorizationHeader: string | undefined,
  sessionSecret: string,
): WorkspaceScope {
  const prefix = 'Bearer ';
  if (!authorizationHeader?.startsWith(prefix)) {
    throw new AuthError('Authorization header eksik veya bicimsiz.');
  }
  return verifyAccessToken(sessionSecret, authorizationHeader.slice(prefix.length));
}

/**
 * bcrypt yalniz ilk 72 byte'i okur; fazlasi sessizce yok sayilir ve sonlari
 * farkli iki parola ayni kabul edilirdi. Kayit ve giriste acikca reddedilir.
 */
const PASSWORD_TOO_LONG = `Parola en fazla ${BCRYPT_MAX_PASSWORD_BYTES} UTF-8 byte olabilir.`;

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).refine(passwordFitsBcryptLimit, PASSWORD_TOO_LONG),
  displayName: z.string().min(1).max(120),
  workspaceName: z.string().min(1).max(120),
  deviceLabel: z.string().min(1).max(80).optional(),
  surface: clientSurfaceSchema.optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).refine(passwordFitsBcryptLimit, PASSWORD_TOO_LONG),
  workspaceId: z.string().optional(),
  deviceLabel: z.string().min(1).max(80).optional(),
  surface: clientSurfaceSchema.optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const logoutSchema = z.object({ refreshToken: z.string().min(1) });
const pairingStartSchema = z.object({ surface: clientSurfaceSchema });
const pairingCodeSchema = z.object({ code: z.string().min(1) });

export interface AuthRoutesDeps {
  db: DbHandle;
  sessionSecret: string;
  /**
   * Kimliksiz `/register` ucu. VARSAYILAN KAPALI: acik kayit, internetten herkesin
   * workspace acip sunucunun LLM/embedding anahtarini ve CPU'yu tuketmesi demektir.
   * Hesaplar seed betigiyle acilir; ucu acmak `SMITH_ALLOW_REGISTRATION=1` ister.
   */
  allowRegistration?: boolean;
}

interface TokenPairBody {
  accessToken: string;
  refreshToken: string;
}

type RefreshOutcome =
  | { kind: 'ok'; body: TokenPairBody }
  | { kind: 'invalid' }
  | { kind: 'membership-ended' }
  | { kind: 'reuse' };

export function createAuthRoutes(deps: AuthRoutesDeps): Hono {
  const { db, sessionSecret, allowRegistration = false } = deps;
  const app = new Hono();
  const loginLimiter = createAttemptLimiter({ secret: sessionSecret, policy: LOGIN_POLICY });
  // Kimliksiz uclar: her istek bir denemedir, kota dolunca govde okunmadan 429.
  const limitedBy = (policy: AttemptPolicy) =>
    limitByIp(createAttemptLimiter({ secret: sessionSecret, policy }));
  app.use('/register', limitedBy(REGISTER_POLICY));
  app.use('/pairing/start', limitedBy(PAIRING_START_POLICY));
  app.use('/pairing/exchange', limitedBy(PAIRING_EXCHANGE_POLICY));
  const refreshReplays = createRefreshReplayCache();
  /** Ayni token icin eszamanli istekler tek rotasyonda birlesir. */
  const refreshFlights = new Map<string, Promise<RefreshOutcome>>();

  const GENERIC_LOGIN_FAILURE = 'E-posta veya sifre gecersiz.';

  function issueTokenPair(scope: { workspaceId: string; actorId: string; role: Role }) {
    return { accessToken: issueAccessToken(sessionSecret, scope) };
  }

  /**
   * Tolerans penceresindeki tekrar: yeni token hala aktifse ilk yaniti
   * dondurur. Yeni token bu arada tuketildiyse (yeniden rotasyon, cikis)
   * tekrar dagitilmaz; pencere icinde eski token aileyi iptal ettirmez, yalniz
   * reddedilir. Pencere disi yeniden kullanim rotasyon yolunda aile iptalidir.
   */
  async function replayRotation(tokenHash: string): Promise<RefreshOutcome | null> {
    const replay = refreshReplays.recall(tokenHash);
    if (!replay) return null;
    const replacement = await withScope(
      db.prisma,
      createSystemScope('refresh tolerans: yeni token dogrulama'),
      (tx) => findActiveRefreshTokenByHash(tx, replay.replacementHash),
    );
    return replacement ? { kind: 'ok', body: replay.body } : { kind: 'invalid' };
  }

  async function rotateRefresh(tokenHash: string): Promise<RefreshOutcome> {
    const lookupScope = createSystemScope('refresh: atomik token rotasyonu');
    const result = await withScope(db.prisma, lookupScope, async (tx) => {
      // Token satiri kilitlenir: ayni token'in rotasyonu tek transaction'da,
      // ikinci istek kilit acilinca iptal edilmis satiri gorur.
      await tx.$queryRaw`
        SELECT "id" FROM "RefreshToken" WHERE "tokenHash" = ${tokenHash} FOR UPDATE
      `;
      const existing = await findRefreshTokenByHash(tx, tokenHash);
      if (!existing) return { kind: 'invalid' } as const;
      if (existing.revokedAt) {
        // Iptal edilmis ama gecmiste var olmus bir token yeniden sunuluyorsa
        // bu calinti sinyalidir (tolerans penceresi disinda): mesru istemci
        // zaten rotasyonu tamamlamis olmali. Ayni soydaki (family) TUM
        // tokenlar iptal edilir.
        await revokeRefreshTokenFamily(tx, existing.family);
        return { kind: 'reuse', family: existing.family } as const;
      }
      if (existing.expiresAt.getTime() <= Date.now()) return { kind: 'invalid' } as const;

      // Rol her refresh'te YENIDEN okunur: erisim token'inin kisa TTL'i normal
      // durumda staleness'i sinirlar, refresh onu tamamen sifirlar -- rol bir
      // kez token'a gomulup sonsuza dek tasinmaz.
      //
      // Membership RLS'li, SystemScope ise session degiskenini set etmez (FORCE
      // RLS bos kume dondurur). Token satirinin workspace'i artik biliniyor:
      // degisken ayni transaction icinde elle kurulur (withScope'un yaptigi).
      await tx.$executeRaw`SELECT set_config(${RLS_SESSION_VARIABLE}, ${existing.workspaceId}, true)`;
      const membership = await findMembership(
        tx,
        toWorkspaceId(existing.workspaceId),
        existing.actorId,
      );
      if (!membership) {
        await revokeRefreshToken(tx, existing.id);
        return { kind: 'membership-ended' } as const;
      }

      const scope = createWorkspaceScope({
        workspaceId: existing.workspaceId,
        actorId: existing.actorId,
        role: asRole(membership.role),
      });
      const rotated = generateRefreshToken(existing.family);
      await revokeRefreshToken(tx, existing.id);
      await createRefreshToken(tx, {
        actorId: existing.actorId,
        workspaceId: existing.workspaceId,
        tokenHash: rotated.tokenHash,
        family: rotated.family,
        deviceLabel: existing.deviceLabel,
        surface: existing.surface,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      });
      return { kind: 'rotated', scope, rotated } as const;
    });

    if (result.kind === 'reuse') {
      refreshReplays.forgetFamily(result.family);
      return { kind: 'reuse' };
    }
    if (result.kind !== 'rotated') return result;

    const body = { ...issueTokenPair(result.scope), refreshToken: result.rotated.token };
    refreshReplays.remember(tokenHash, {
      family: result.rotated.family,
      replacementHash: result.rotated.tokenHash,
      body,
    });
    return { kind: 'ok', body };
  }

  /** Ayni token icin surmekte olan rotasyona katilir; yoksa baslatir. */
  function rotateOnce(tokenHash: string): Promise<RefreshOutcome> {
    const running = refreshFlights.get(tokenHash);
    if (running) return running;
    const flight = rotateRefresh(tokenHash).finally(() => refreshFlights.delete(tokenHash));
    refreshFlights.set(tokenHash, flight);
    return flight;
  }

  app.post('/register', async (c) => {
    if (!allowRegistration) return c.json({ error: 'Kayit kapali.' }, 403);
    const body = registerSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const { email, password, displayName, workspaceName } = body.data;

    const existing = await withScope(
      db.prisma,
      createSystemScope('kayit: eposta cakisma kontrolu'),
      (tx) => findActorByEmail(tx, email),
    );
    if (existing) return c.json({ error: 'Bu e-posta zaten kayitli.' }, 409);

    const workspaceId = newWorkspaceId();
    const actorId = newActorId();
    const role: Role = 'owner';
    const scope = createWorkspaceScope({ workspaceId, actorId, role });
    const passwordHash = await hashPassword(password);
    const issued = generateRefreshToken();

    await withScope(db.prisma, scope, async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: workspaceName } });
      await tx.actor.create({
        data: { id: actorId, email, displayName, workspaceIds: [workspaceId] },
      });
      await tx.membership.create({ data: { workspaceId, actorId, role } });
      await upsertCredential(tx, actorId, passwordHash);
      await createRefreshToken(tx, {
        actorId,
        workspaceId,
        tokenHash: issued.tokenHash,
        family: issued.family,
        deviceLabel: body.data.deviceLabel ?? 'ilk-kayit',
        surface: body.data.surface ?? 'web',
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      });
    });

    return c.json({
      ...issueTokenPair(scope),
      refreshToken: issued.token,
      workspaceId,
      actorId,
      role,
    });
  });

  app.post('/login', async (c) => {
    const body = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);

    const remoteAddress = resolveRemoteAddress(c);
    const limiterKey = loginLimiter.keyFor(remoteAddress, body.data.email);
    const authentication = await loginLimiter.serialize(limiterKey, async () => {
      const waitingMs = loginLimiter.retryAfterMs(limiterKey);
      if (waitingMs > 0) return { kind: 'limited', waitingMs } as const;

      const lookupScope = createSystemScope('giris: eposta ve kimlik bilgisi cozumleme');
      const resolved = await withScope(db.prisma, lookupScope, async (tx) => {
        const actor = await findActorByEmail(tx, body.data.email);
        if (!actor) return null;
        const credential = await findCredentialByActorId(tx, actor.id);
        if (!credential) return null;
        return { actor, credential };
      });

      // Eposta bulunamadi ile sifre yanlis ayni mesaji doner VE ayni sureyi alir:
      // hesap yokken sahte bcrypt maliyeti odenir, yoksa yanit suresi (~1 ms
      // karsi ~250 ms) hangisinin dogru oldugunu sizdirirdi.
      if (!resolved) await burnPasswordCost(body.data.password);
      if (
        !resolved ||
        !(await verifyPassword(body.data.password, resolved.credential.passwordHash))
      ) {
        loginLimiter.recordFailure(limiterKey);
        const blockedMs = loginLimiter.retryAfterMs(limiterKey);
        if (blockedMs > 0) {
          console.warn(
            `[gateway] giris hiz siniri devrede: ${remoteAddress ?? 'adres bilinmiyor'}, ${Math.ceil(blockedMs / 1000)} sn bekleme`,
          );
        }
        return { kind: 'failure' } as const;
      }
      loginLimiter.recordSuccess(limiterKey);
      return { kind: 'ok', resolved } as const;
    });
    if (authentication.kind === 'limited') {
      return tooManyRequests(c, authentication.waitingMs, 'Cok fazla basarisiz giris denemesi.');
    }
    if (authentication.kind === 'failure') {
      return c.json({ error: GENERIC_LOGIN_FAILURE }, 401);
    }
    const { resolved } = authentication;

    // actor.workspaceIds SADECE kesif icindir (Membership RLS'li oldugu icin
    // "bu actor hangi workspace'lere uye" sorusu smith_app+herhangi bir scope
    // ile Membership'ten dogrudan cevaplanamaz -- bkz. schema.prisma Actor
    // yorumu). Asil yetki karari asagida targetWorkspaceId belirlendikten
    // SONRA, o workspace'e ozel bir scope'la findMembership'ten gelir.
    const { workspaceIds } = resolved.actor;

    let targetWorkspaceId: string;
    if (body.data.workspaceId) {
      let validated: string;
      try {
        validated = toWorkspaceId(body.data.workspaceId);
      } catch (error) {
        if (error instanceof InvalidScopeError) return c.json({ error: error.message }, 400);
        throw error;
      }
      if (!workspaceIds.includes(validated)) {
        return c.json({ error: 'Bu workspace icin uyeliginiz yok.' }, 403);
      }
      targetWorkspaceId = validated;
    } else if (workspaceIds.length === 0) {
      return c.json({ error: 'Hicbir workspace uyeliginiz yok.' }, 403);
    } else if (workspaceIds.length === 1) {
      const [onlyWorkspaceId] = workspaceIds;
      if (!onlyWorkspaceId) return c.json({ error: 'Uyelik bulunamadi.' }, 403);
      targetWorkspaceId = onlyWorkspaceId;
    } else {
      return c.json(
        { error: 'Birden fazla workspace uyeliginiz var, hangisini secin.', workspaceIds },
        409,
      );
    }

    // Membership RLS'li: SystemScope burada Membership'i asla goremez (FORCE
    // RLS session degiskeni set edilmeden bos kume doner). role:'viewer'
    // gecici deger -- sadece dogru session degiskenini set etmek icin;
    // membership.role tek gercek kaynaktir.
    const actorId = resolved.actor.id;
    const membership = await withScope(
      db.prisma,
      createWorkspaceScope({ workspaceId: targetWorkspaceId, actorId, role: 'viewer' }),
      (tx) => findMembership(tx, toWorkspaceId(targetWorkspaceId), actorId),
    );
    // workspaceIds'te olup Membership'te olmamasi (kesif indeksi ile gercek
    // satirin driftlemesi) beklenmez ama savunma yapilir: sessizce guvenmek
    // yerine acikca reddedilir.
    if (!membership) return c.json({ error: 'Uyelik bulunamadi.' }, 403);
    const role = asRole(membership.role);
    const scope = createWorkspaceScope({ workspaceId: targetWorkspaceId, actorId, role });
    const issued = generateRefreshToken();

    await withScope(db.prisma, scope, (tx) =>
      createRefreshToken(tx, {
        actorId,
        workspaceId: targetWorkspaceId,
        tokenHash: issued.tokenHash,
        family: issued.family,
        deviceLabel: body.data.deviceLabel ?? 'web',
        surface: body.data.surface ?? 'web',
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      }),
    );

    return c.json({
      ...issueTokenPair(scope),
      refreshToken: issued.token,
      workspaceId: targetWorkspaceId,
      actorId,
      role,
    });
  });

  app.post('/refresh', async (c) => {
    const body = refreshSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);

    const tokenHash = hashRefreshTokenCandidate(body.data.refreshToken);
    const outcome = (await replayRotation(tokenHash)) ?? (await rotateOnce(tokenHash));

    if (outcome.kind === 'ok') return c.json(outcome.body);
    if (outcome.kind === 'membership-ended') {
      return c.json({ error: 'Uyelik sonlandirilmis.' }, 403);
    }
    if (outcome.kind === 'reuse') {
      return c.json(
        { error: 'Oturum guvenlik nedeniyle sonlandirildi, yeniden giris yapin.' },
        401,
      );
    }
    return c.json({ error: 'Gecersiz refresh token.' }, 401);
  });

  app.post('/logout', async (c) => {
    const body = logoutSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);

    const tokenHash = hashRefreshTokenCandidate(body.data.refreshToken);
    // Bulunamasa da basarili doner: cikis islemi idempotenttir, token'in
    // gecerliligi hakkinda bilgi sizdirmaz. Bulunursa AILENIN tamami iptal edilir:
    // rotasyonla iptal edilmis eski bir token sunulmasi (calinti sinyali) ya da
    // eszamanli bir rotasyon, ailenin guncel token'ini canli birakmasin.
    const family = await withScope(
      db.prisma,
      createSystemScope('cikis: refresh token iptali'),
      async (tx) => {
        // Rotasyonla ayni satir kilidi: ikisi ayni anda kosamaz.
        await tx.$queryRaw`
          SELECT "id" FROM "RefreshToken" WHERE "tokenHash" = ${tokenHash} FOR UPDATE
        `;
        const existing = await findRefreshTokenByHash(tx, tokenHash);
        if (!existing) return null;
        await revokeRefreshTokenFamily(tx, existing.family);
        return existing.family;
      },
    );
    if (family) refreshReplays.forgetFamily(family);

    return c.json({ ok: true });
  });

  app.post('/pairing/start', async (c) => {
    const body = pairingStartSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);

    const issued = generatePairingCode();
    await withScope(db.prisma, createSystemScope('eslestirme: kod olusturma'), (tx) =>
      createDevicePairing(tx, {
        codeHash: issued.codeHash,
        surface: body.data.surface,
        expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000),
      }),
    );

    return c.json({ code: issued.code, expiresInSeconds: PAIRING_CODE_TTL_SECONDS });
  });

  app.post('/pairing/approve', async (c) => {
    let scope: WorkspaceScope;
    try {
      scope = requireAccessToken(c.req.header('Authorization'), sessionSecret);
    } catch (error) {
      return c.json(
        { error: error instanceof AuthError ? error.message : 'Kimlik dogrulanamadi.' },
        401,
      );
    }

    const body = pairingCodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);

    const codeHash = hashPairingCandidate(body.data.code);
    const approved = await withScope(db.prisma, scope, async (tx) => {
      const pending = await findPendingDevicePairingByCodeHash(tx, codeHash);
      if (!pending) return null;
      return approveDevicePairing(tx, pending.id, scope);
    });

    if (!approved)
      return c.json({ error: 'Kod bulunamadi, suresi dolmus veya zaten onaylanmis.' }, 404);
    return c.json({ ok: true });
  });

  app.post('/pairing/exchange', async (c) => {
    const body = pairingCodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);

    const codeHash = hashPairingCandidate(body.data.code);
    const lookupScope = createSystemScope('eslestirme: kod degisimi');

    // Kodu tuketmek ve refresh token'i yazmak TEK transaction: ikincisi
    // hata verirse kod yanmaz, cihaz ayni kodla yeniden deneyebilir.
    const issued = generateRefreshToken();
    const exchange = await withScope(db.prisma, lookupScope, async (tx) => {
      const record = await findDevicePairingByCodeHash(tx, codeHash);
      if (!record || record.expiresAt.getTime() < Date.now()) return { kind: 'missing' } as const;
      if (record.status === 'pending') return { kind: 'pending' } as const;
      if (record.status !== 'approved') return { kind: 'gone' } as const;

      const consumed = await consumeDevicePairing(tx, codeHash);
      // approved durumundaki bir kaydin bu uc alani her zaman dolu olur
      // (approveDevicePairing hepsini birlikte yazar); eksikse kod gecersizdir.
      const { approvedActorId, approvedWorkspaceId, approvedRole } = consumed ?? {};
      if (!approvedActorId || !approvedWorkspaceId || !approvedRole) {
        return { kind: 'gone' } as const;
      }
      const role = asRole(approvedRole);
      await createRefreshToken(tx, {
        actorId: approvedActorId,
        workspaceId: approvedWorkspaceId,
        tokenHash: issued.tokenHash,
        family: issued.family,
        deviceLabel: `eslestirilmis-${record.surface}`,
        surface: record.surface,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      });
      return {
        kind: 'ok',
        role,
        actorId: approvedActorId,
        workspaceId: approvedWorkspaceId,
      } as const;
    });

    if (exchange.kind === 'missing') {
      return c.json({ error: 'Kod bulunamadi veya suresi dolmus.' }, 404);
    }
    if (exchange.kind === 'pending') {
      return c.json({ error: 'Henuz onaylanmadi, tekrar deneyin.' }, 202);
    }
    if (exchange.kind === 'gone') return c.json({ error: 'Kod artik gecerli degil.' }, 410);
    const scope = createWorkspaceScope({
      workspaceId: exchange.workspaceId,
      actorId: exchange.actorId,
      role: exchange.role,
    });

    return c.json({
      ...issueTokenPair(scope),
      refreshToken: issued.token,
      workspaceId: exchange.workspaceId,
      actorId: exchange.actorId,
      role: exchange.role,
    });
  });

  return app;
}
