import { issueAccessToken } from '@smith/auth';
import { findActorByEmail, findMembership, withScope, type DbHandle } from '@smith/db';
import type { NodeEnvName } from '@smith/env';
import {
  createSystemScope,
  createWorkspaceScope,
  InvalidScopeError,
  toWorkspaceId,
  type WorkspaceId,
} from '@smith/tenancy';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { isLoopbackAddress, resolveRemoteAddress } from '../network.js';
import { asRole } from './auth.js';

/**
 * Gelistirme kisayolu: sifre dogrulamadan mevcut bir uyeligi token'a cevirir.
 * Gercek girisin (sifre + refresh) yerini TUTMAZ -- @smith/auth /v1/auth/login
 * onu yapar. Bu, sifirdan kayit olmadan hizli lokal test icin kalir.
 *
 * Sifresiz token basan bir uc oldugu icin IKI kosul birlikte aranir:
 *   1) NODE_ENV=development (uretimde asla acik degil),
 *   2) istek loopback'ten geliyor. Gateway eskiden tum arayuzlerde dinliyordu;
 *      ayni agdaki herhangi bir makine uyelik e-postasini bilerek token alabilirdi.
 *      Dinleme adresi daraltildi ama savunma tek katmana dayanmasin diye uc
 *      kendi basina da uzak adresi reddeder.
 * Biri saglanmazsa 403 doner; ikisi de ayni yaniti verir ki uc, ortami sizdirmasin.
 */
const devLoginSchema = z.object({ email: z.string().email(), workspaceId: z.string() });

export interface DevLoginRouteDeps {
  db: DbHandle;
  sessionSecret: string;
  nodeEnv: NodeEnvName;
  /** Istegin uzak soket adresi. Testte soket yoktur; varsayilan Node soketini okur. */
  getRemoteAddress?: (c: Context) => string | undefined;
}

export function createDevLoginRoutes(deps: DevLoginRouteDeps): Hono {
  const { db, sessionSecret, nodeEnv, getRemoteAddress = resolveRemoteAddress } = deps;
  const routes = new Hono();

  routes.post('/login', async (c) => {
    if (nodeEnv !== 'development' || !isLoopbackAddress(getRemoteAddress(c))) {
      return c.json({ error: 'dev login yalniz yerel gelistirme icindir' }, 403);
    }

    const body = devLoginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'email ve workspaceId gerekli' }, 400);

    let workspaceId: WorkspaceId;
    try {
      workspaceId = toWorkspaceId(body.data.workspaceId);
    } catch (error) {
      if (error instanceof InvalidScopeError) return c.json({ error: error.message }, 400);
      throw error;
    }

    const actor = await withScope(
      db.prisma,
      createSystemScope('dev-login: eposta ile actor arama'),
      (tx) => findActorByEmail(tx, body.data.email),
    );
    if (!actor) return c.json({ error: 'uyelik bulunamadi' }, 403);

    // Membership RLS'li: SystemScope onu asla goremez. Rol henuz bilinmedigi
    // icin gecici bir role ile gercek bir WorkspaceScope kurulup dogru
    // session degiskeni set edilir; membership.role tek gercek kaynaktir.
    const membership = await withScope(
      db.prisma,
      createWorkspaceScope({ workspaceId, actorId: actor.id, role: 'viewer' }),
      (tx) => findMembership(tx, workspaceId, actor.id),
    );
    if (!membership) return c.json({ error: 'uyelik bulunamadi' }, 403);

    const role = asRole(membership.role);
    const token = issueAccessToken(sessionSecret, {
      workspaceId,
      actorId: actor.id,
      role,
      ttlSeconds: 60 * 60 * 12,
    });
    return c.json({ token, actorId: actor.id, role });
  });

  return routes;
}
