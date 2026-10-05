import { z, type ZodTypeAny } from 'zod';

/**
 * Zod semasini modele gonderilecek JSON Schema'ya cevirir.
 *
 * `packages/core` araclari parametrelerini Zod ile tanimlar (dogrulama icin);
 * saglayicilar ise JSON Schema ister. Bu donusturucu bu sinirda yasar — core
 * saglayici-notr kalir. Bilincli olarak YALIN semalarla sinirli (obje +
 * string/number/boolean/enum/array + optional/default): bugunku araclarin
 * ihtiyaci bu. Daha karmasik bir sema cikinca burasi genisletilir (ya da
 * `zod-to-json-schema` bagimliligi o zaman tartisilir).
 */
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const description = schema.description;
  const base = convert(schema);
  return description !== undefined ? { ...base, description } : base;
}

function convert(schema: ZodTypeAny): Record<string, unknown> {
  // Zod v3 getter'lari `any` doner; `as ZodTypeAny` ile tip-guvenli kilinir.
  if (schema instanceof z.ZodOptional) return convert(schema.unwrap() as ZodTypeAny);
  if (schema instanceof z.ZodDefault) return convert(schema._def.innerType as ZodTypeAny);
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum)
    return { type: 'string', enum: [...(schema.options as readonly string[])] };
  if (schema instanceof z.ZodArray)
    return { type: 'array', items: convert(schema.element as ZodTypeAny) };
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape as Record<string, ZodTypeAny>)) {
      const prop = convert(value);
      properties[key] =
        value.description !== undefined ? { ...prop, description: value.description } : prop;
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) required.push(key);
    }
    return required.length > 0
      ? { type: 'object', properties, required }
      : { type: 'object', properties };
  }
  // Bilinmeyen tip: kisitsiz obje — arac yine calisir, model serbest birakilir.
  return { type: 'object' };
}
