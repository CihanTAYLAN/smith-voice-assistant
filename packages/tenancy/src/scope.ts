/**
 * Cok kiracili sistemin tasiyici kolonu.
 *
 * Tasarim karari: kapsam (scope) bir *deger* degil, tasinmasi zorunlu bir
 * *yetkidir*. Veri okuyan hicbir fonksiyon Scope almadan derlenmez; boylece
 * "tenant filtresini unutmak" bir runtime bug'i degil, bir derleme hatasi olur.
 * Sessiz tenant sizintisinin onlenmesi buna dayanir.
 */

declare const brand: unique symbol;

/** Markali tip: duz string buraya atanamaz, once dogrulanmak zorundadir. */
export type WorkspaceId = string & { readonly [brand]: 'WorkspaceId' };
export type ActorId = string & { readonly [brand]: 'ActorId' };

export const WORKSPACE_ID_PATTERN = /^ws_[0-9a-z]{20,32}$/;
export const ACTOR_ID_PATTERN = /^act_[0-9a-z]{20,32}$/;

export class InvalidScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScopeError';
  }
}

export function toWorkspaceId(raw: string): WorkspaceId {
  if (!WORKSPACE_ID_PATTERN.test(raw)) {
    throw new InvalidScopeError(`Gecersiz workspace id: ${JSON.stringify(raw)}`);
  }
  return raw as WorkspaceId;
}

export function toActorId(raw: string): ActorId {
  if (!ACTOR_ID_PATTERN.test(raw)) {
    throw new InvalidScopeError(`Gecersiz actor id: ${JSON.stringify(raw)}`);
  }
  return raw as ActorId;
}

/** Sistem genelinde tanimli roller. Kota ve yetki kararlari buna bakar. */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Readonly<Record<Role, number>> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
};

/**
 * Her veri erisimi bunu tasir. Bir HTTP istegi daima WorkspaceScope uretir;
 * SystemScope yalnizca migration ve arka plan bakim islerinde elde edilir.
 */
export interface WorkspaceScope {
  readonly workspaceId: WorkspaceId;
  readonly actorId: ActorId;
  readonly role: Role;
  readonly system: false;
}

/**
 * Tenant sinirini asan kapsam. Gerekce zorunludur: audit log'da neden
 * asildigi yazili olmadan uretilemez.
 */
export interface SystemScope {
  readonly system: true;
  readonly reason: string;
}

export type Scope = WorkspaceScope | SystemScope;

export function isSystemScope(scope: Scope): scope is SystemScope {
  return scope.system;
}

export function createWorkspaceScope(input: {
  workspaceId: string;
  actorId: string;
  role: Role;
}): WorkspaceScope {
  return {
    workspaceId: toWorkspaceId(input.workspaceId),
    actorId: toActorId(input.actorId),
    role: input.role,
    system: false,
  };
}

export function createSystemScope(reason: string): SystemScope {
  if (reason.trim().length < 8) {
    throw new InvalidScopeError('Sistem kapsami icin anlamli bir gerekce zorunlu.');
  }
  return { system: true, reason };
}

export function hasAtLeastRole(scope: Scope, required: Role): boolean {
  if (isSystemScope(scope)) return true;
  return ROLE_RANK[scope.role] >= ROLE_RANK[required];
}

export class ForbiddenError extends Error {
  constructor(
    message: string,
    readonly required: Role,
  ) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export function requireRole(scope: Scope, required: Role): void {
  if (!hasAtLeastRole(scope, required)) {
    throw new ForbiddenError(`Bu islem en az '${required}' rolu gerektirir.`, required);
  }
}
