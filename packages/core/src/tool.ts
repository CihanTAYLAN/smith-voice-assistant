/**
 * Arac tanimi ve registry.
 *
 * `defineTool` tipli bir authoring sozlesmesidir: Zod semasi hem modele gidecek
 * arac tanimini hem de `execute`'un girdi tipini uretir (dsh'nin `defineTool`
 * deseninden, Cordis'siz ve Zod ile — ADR 0010).
 *
 * Registry'de saklanan `AgentTool` ise sema-erased'dir: `parameters` daima
 * `ZodTypeAny`, `execute` girdiyi `unknown` alir. Bu bilinclidir — loop, execute'u
 * HER ZAMAN once `parameters` ile dogrular (safeParse) ve dogrulanmis veriyi
 * gecirir; boylece tek bir generic parametre tum registry'ye yayilmaz.
 */

import type { TypeOf, ZodTypeAny } from 'zod';
import type { ToolRunContext, ToolSpec } from './types.js';

/** Aracin nerede calistigi. Server: loop icinde. Device: `tool_call` frame'i ile cihazda. */
export type ToolLocus = 'server' | 'device';

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodTypeAny;
  readonly locus: ToolLocus;
  /** Yalniz 'server' locus'unda tanimli; girdiyi dogrulanmis kabul eder. */
  readonly execute?: (input: unknown, ctx: ToolRunContext) => Promise<unknown>;
  /** Geri donusu olmayan is (bicimlendirme/kapatma). Guard ve onay buna bakar. */
  readonly irreversible?: boolean;
}

export interface DefineToolSpec<S extends ZodTypeAny> {
  name: string;
  description: string;
  parameters: S;
  /** Varsayilan 'server'. */
  locus?: ToolLocus;
  execute?: (input: TypeOf<S>, ctx: ToolRunContext) => Promise<unknown>;
  irreversible?: boolean;
}

export function defineTool<S extends ZodTypeAny>(spec: DefineToolSpec<S>): AgentTool {
  const locus: ToolLocus = spec.locus ?? 'server';
  if (locus === 'server' && !spec.execute) {
    throw new Error(`Server araci '${spec.name}' execute() olmadan tanimlanamaz.`);
  }
  const authored = spec.execute;
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    locus,
    // Saklanan execute girdiyi `unknown` gorur; loop onu HER ZAMAN `parameters`
    // ile dogruladiktan (safeParse) sonra cagirir.
    ...(authored ? { execute: authored } : {}),
    ...(spec.irreversible !== undefined ? { irreversible: spec.irreversible } : {}),
  };
}

/**
 * Global arac registry'si. Ad cakismasi sessizce yutulmaz; kayit hatasi verir
 * (dsh'nin isaretledigi cift-ad tuzagindan kacinma).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Arac adi cakismasi: '${tool.name}' zaten kayitli.`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): readonly AgentTool[] {
    return [...this.tools.values()];
  }

  /** Modele gonderilecek saglayici-notr arac tanimlari. */
  specs(): readonly ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}
