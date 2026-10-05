import { defineConfig } from 'prisma/config';

/**
 * Prisma 7: migrate/CLI baglanti URL'i burada.
 *
 * Migration'lar superuser rolu (smith) ile kosar — DDL ve RLS politikasi
 * kurmak icin. Uygulama runtime'i AYRI bir baglanti kullanir (smith_app,
 * RLS'e tabi) ve PrismaClient'a adapter ile verilir (src/client.ts).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  },
});
