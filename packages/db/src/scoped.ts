import type { PrismaClient } from '@prisma/client';
import { isSystemScope, RLS_SESSION_VARIABLE, type Scope } from '@smith/tenancy';

/**
 * Kapsamli transaction: tenant verisine dokunan HER okuma/yazma buradan gecer.
 *
 * Transaction acilir acilmaz RLS oturum degiskeni set edilir; boylece
 * uygulama katmani bir where filtresini kacirsa bile Postgres politikasi
 * yanlis tenant'in satirini dondurmez. Iki katmanli savunmanin ikinci katmani.
 *
 * SystemScope ile cagrilirsa degisken set edilmez — smith_app rolunde RLS
 * FORCE oldugu icin sonuc BOS KUMEDIR, veri sizmasi degildir. Sistem isleri
 * (migration, bakim) superuser baglantisiyla ayrica kosulur.
 */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export async function withScope<T>(
  prisma: PrismaClient,
  scope: Scope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (!isSystemScope(scope)) {
      // set_config(name, value, is_local=true) → yalniz bu transaction icin.
      await tx.$executeRaw`SELECT set_config(${RLS_SESSION_VARIABLE}, ${scope.workspaceId}, true)`;
    }
    return fn(tx);
  });
}
