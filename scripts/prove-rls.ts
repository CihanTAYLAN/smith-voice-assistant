/**
 * RLS izolasyon kaniti. CI'da ve yerelde kosulabilir.
 *
 * Senaryo:
 *   1. Superuser olarak iki workspace + birer mesaj yaz.
 *   2. Uygulama rolu (smith_app) ile baglan:
 *      a. A kapsamiyla → yalniz A'nin satiri gorunmeli.
 *      b. B kapsamiyla → yalniz B'nin satiri gorunmeli (A'ninki ASLA).
 *      c. Kapsam set edilmeden → SIFIR satir (fail-closed).
 *      d. WHERE filtresi olmadan bile → sadece kendi tenant'i (RLS son soz).
 *
 * Kullanim:
 *   MIGRATE_DATABASE_URL=postgres://smith:...@127.0.0.1:5433/smith \
 *   APP_DATABASE_URL=postgres://smith_app:...@127.0.0.1:5433/smith \
 *   pnpm prove:rls
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const su = process.env.MIGRATE_DATABASE_URL;
const app = process.env.APP_DATABASE_URL;
if (!su || !app) {
  console.error('MIGRATE_DATABASE_URL ve APP_DATABASE_URL gerekli.');
  process.exit(2);
}

const id = (p: string) => `${p}_${randomUUID().replace(/-/g, '')}`;
const wsA = id('ws');
const wsB = id('ws');
const actor = id('act');

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
  if (!ok) failures += 1;
}

// --- 1. Superuser: iki tenant kur ---
const root = new Client({ connectionString: su });
await root.connect();
await root.query('BEGIN');
await root.query(
  `INSERT INTO "Workspace" (id, name) VALUES ($1, 'rls-proof-a'), ($2, 'rls-proof-b')`,
  [wsA, wsB],
);
await root.query(`INSERT INTO "Actor" (id, email, "displayName") VALUES ($1, $2, 'RLS Proof')`, [
  actor,
  `${actor}@rls.test`,
]);
await root.query(
  `INSERT INTO "Membership" ("workspaceId", "actorId", role) VALUES ($1, $3, 'owner'), ($2, $3, 'owner')`,
  [wsA, wsB, actor],
);
const sesA = id('ses');
const sesB = id('ses');
await root.query(
  `INSERT INTO "Session" (id, "workspaceId", "actorId", surface) VALUES ($1, $2, $5, 'cli'), ($3, $4, $5, 'cli')`,
  [sesA, wsA, sesB, wsB, actor],
);
await root.query(
  `INSERT INTO "Message" (id, "workspaceId", "sessionId", "authorRole", text) VALUES ($1, $2, $3, 'user', 'tenant-A-sirri'), ($4, $5, $6, 'user', 'tenant-B-sirri')`,
  [id('msg'), wsA, sesA, id('msg'), wsB, sesB],
);
await root.query('COMMIT');

// --- 2. Uygulama rolu ---
const client = new Client({ connectionString: app });
await client.connect();

async function scopedMessages(workspaceId: string | null): Promise<string[]> {
  await client.query('BEGIN');
  if (workspaceId) {
    await client.query(`SELECT set_config('smith.workspace_id', $1, true)`, [workspaceId]);
  }
  // Bilerek WHERE'siz: uygulama filtreyi unutsa bile RLS'in tuttugunu kanitlar.
  const rows = await client.query(
    `SELECT text FROM "Message" WHERE text LIKE 'tenant-%-sirri' ORDER BY text`,
  );
  await client.query('COMMIT');
  return rows.rows.map((r: { text: string }) => r.text);
}

const seenA = await scopedMessages(wsA);
check(
  'A kapsami yalniz A verisini gorur',
  seenA.length === 1 && seenA[0] === 'tenant-A-sirri',
  JSON.stringify(seenA),
);

const seenB = await scopedMessages(wsB);
check(
  'B kapsami yalniz B verisini gorur',
  seenB.length === 1 && seenB[0] === 'tenant-B-sirri',
  JSON.stringify(seenB),
);

const seenNone = await scopedMessages(null);
check(
  'Kapsamsiz sorgu SIFIR satir dondurur (fail-closed)',
  seenNone.length === 0,
  JSON.stringify(seenNone),
);

// Yazma tarafi: B kapsamindayken A'ya mesaj yazmayi dene → WITH CHECK reddetmeli.
let writeBlocked = false;
try {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('smith.workspace_id', $1, true)`, [wsB]);
  await client.query(
    `INSERT INTO "Message" (id, "workspaceId", "sessionId", "authorRole", text) VALUES ($1, $2, $3, 'user', 'saldiri')`,
    [id('msg'), wsA, sesA],
  );
  await client.query('COMMIT');
} catch {
  writeBlocked = true;
  await client.query('ROLLBACK');
}
check(
  'B kapsami A adina YAZAMAZ (WITH CHECK)',
  writeBlocked,
  'insert basariliydi — politika delik',
);

// --- temizlik ---
await root.query(`DELETE FROM "Workspace" WHERE id IN ($1, $2)`, [wsA, wsB]);
await root.query(`DELETE FROM "Actor" WHERE id = $1`, [actor]);
await root.end();
await client.end();

if (failures > 0) {
  console.error(`\n${failures} kontrol BASARISIZ — tenant izolasyonu KANITLANAMADI.`);
  process.exit(1);
}
console.log('\nTum kontroller gecti: tenant izolasyonu Postgres seviyesinde kanitli.');
