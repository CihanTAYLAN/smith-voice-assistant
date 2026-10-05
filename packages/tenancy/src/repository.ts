import { isSystemScope, type Scope, type WorkspaceId } from './scope.js';

/**
 * Kapsamli sorgu sozlesmesi.
 *
 * Bir tablo daima bu filtreyle okunur. Amac gelistiriciye guvenmek degil,
 * filtreyi atlamayi ifade edilemez kilmaktir.
 */
export interface ScopedFilter {
  readonly workspaceId?: WorkspaceId;
}

/**
 * Kapsamdan veri katmanina gecirilecek zorunlu filtreyi uretir.
 * Sistem kapsaminda filtre bostur; o kapsam yalnizca createSystemScope ile
 * gerekce yazilarak elde edilebilir.
 */
export function scopeFilter(scope: Scope): ScopedFilter {
  if (isSystemScope(scope)) return {};
  return { workspaceId: scope.workspaceId };
}

/**
 * Postgres Row Level Security oturum degiskeni.
 *
 * Ikinci savunma katmani: gateway her istegi bir transaction icinde bu
 * degiskeni set ederek acar. Uygulama katmani bir filtreyi kacirsa bile
 * veritabani satiri dondurmez. RLS son soz sahibidir.
 */
export const RLS_SESSION_VARIABLE = 'smith.workspace_id';

/**
 * RLS degiskenini set eden parametreli SQL. Deger DAIMA parametre olarak
 * gecirilir; string interpolasyonu yapilmaz.
 *
 * Sistem kapsaminda null doner: cagiran taraf o durumda RLS'i bypass eden
 * ayri bir rol kullanmak zorundadir ve bunu acikca yapmasi gerekir.
 */
export interface ParameterizedStatement {
  readonly sql: string;
  readonly values: readonly [name: string, value: string];
}

export function rlsSetLocalStatement(scope: Scope): ParameterizedStatement | null {
  if (isSystemScope(scope)) return null;
  return {
    sql: 'SELECT set_config($1, $2, true)',
    values: [RLS_SESSION_VARIABLE, scope.workspaceId],
  };
}

/**
 * RLS politikasinin SQL karsiligi. Migration bunu her tenant tablosuna uygular.
 * Tek noktada tutulur ki bir tablo yanlislikla politikasiz kalmasin.
 */
export function rlsPolicyFor(table: string): string {
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "${table}_workspace_isolation" ON "${table}";`,
    `CREATE POLICY "${table}_workspace_isolation" ON "${table}"`,
    `  USING ("workspaceId" = current_setting('${RLS_SESSION_VARIABLE}', true))`,
    `  WITH CHECK ("workspaceId" = current_setting('${RLS_SESSION_VARIABLE}', true));`,
  ].join('\n');
}
