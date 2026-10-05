/**
 * Gelistirme seed'i. Superuser URL'iyle kosulur (MIGRATE_DATABASE_URL veya
 * DATABASE_URL) — RLS'i bilerek asar, cunku henuz tenant yokken tenant
 * olusturmak sistem isidir.
 *
 * Iki workspace kurar ki cross-tenant izolasyon kanitlanabilsin.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { newActorId, newWorkspaceId } from '../src/ids.js';

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATE_DATABASE_URL veya DATABASE_URL gerekli.');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function ensureWorkspace(name: string, email: string, displayName: string) {
  const existingActor = await prisma.actor.findUnique({ where: { email } });
  const actor =
    existingActor ??
    (await prisma.actor.create({
      data: { id: newActorId(), email, displayName },
    }));

  const existingMembership = await prisma.membership.findFirst({
    where: { actorId: actor.id, workspace: { name } },
    include: { workspace: true },
  });
  if (existingMembership) {
    return { workspace: existingMembership.workspace, actor };
  }

  const workspace = await prisma.workspace.create({
    data: { id: newWorkspaceId(), name },
  });
  await prisma.membership.create({
    data: { workspaceId: workspace.id, actorId: actor.id, role: 'owner' },
  });
  // Actor.workspaceIds Membership'ten ayri tutulur -- her yazan yer
  // guncellemek zorunda (bkz. schema.prisma yorumu).
  await prisma.actor.update({
    where: { id: actor.id },
    data: { workspaceIds: { push: workspace.id } },
  });
  return { workspace, actor };
}

const a = await ensureWorkspace('cihan-personal', 'cihan@example.test', 'Cihan Taylan');
const b = await ensureWorkspace('tenant-b-demo', 'tenant-b@example.test', 'Tenant B (demo)');

console.log(
  JSON.stringify(
    {
      workspaceA: { id: a.workspace.id, name: a.workspace.name, actorId: a.actor.id },
      workspaceB: { id: b.workspace.id, name: b.workspace.name, actorId: b.actor.id },
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
await pool.end();
