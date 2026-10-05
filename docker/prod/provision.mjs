/**
 * Prod DB provision: smith_app rolu + pgvector + grant'ler.
 *
 * Neden var: `smith_app` rolu migration'larin icinde DEGIL; yerel
 * gelistirmede ayri provision adimi bunu kuruyordu. Dokploy'da o adim yok;
 * bu nedenle gateway ayaga kalkmadan once entrypoint bunu calistirir.
 *
 * Idempotent: tekrar calismak zararsiz (IF NOT EXISTS + her boot'ta sifre
 * tazeleme + grant yenileme). Baglanti MIGRATE_DATABASE_URL (superuser).
 * Cikis kodu != 0 ise entrypoint baslamaz.
 */
import { Pool } from 'pg';

const superUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
const appPassword = process.env.SMITH_APP_PASSWORD;
if (!superUrl) {
  console.error('[provision] MIGRATE_DATABASE_URL veya DATABASE_URL gerekli.');
  process.exit(1);
}
if (!appPassword) {
  console.error('[provision] SMITH_APP_PASSWORD gerekli.');
  process.exit(1);
}
if (/['\\]/.test(appPassword)) {
  console.error('[provision] SMITH_APP_PASSWORD tek tirnak veya ters bolu iceremez.');
  process.exit(1);
}

const pool = new Pool({ connectionString: superUrl, connectionTimeoutMillis: 5_000 });

async function main() {
  // Postgres henuz acilmamis olabilir (compose depends_on saglik kapisina
  // ragmen): 60 sn'ye kadar dene, sonra patla.
  for (let i = 1; i <= 30; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (i === 30) throw error;
      process.stdout.write(`[provision] postgres bekleniyor (${i}/30)...\n`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'smith_app') THEN
      CREATE ROLE smith_app LOGIN PASSWORD '${appPassword}';
    END IF;
  END $$;`);
  await pool.query(`ALTER ROLE smith_app LOGIN PASSWORD '${appPassword}';`);
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
  await pool.query('GRANT USAGE ON SCHEMA public TO smith_app;');
  await pool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO smith_app;',
  );
  await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO smith_app;');
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO smith_app;`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO smith_app;`);
  process.stdout.write('[provision] ok (smith_app + vector + grant)\n');
}

try {
  await main();
} finally {
  await pool.end();
}
